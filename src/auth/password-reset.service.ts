import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectEntityManager } from '@nestjs/typeorm';
import { hash } from 'bcryptjs';
import { randomInt } from 'crypto';
import { EntityManager } from 'typeorm';
import { sha256Hex } from '../common/hash.js';
import { MailService } from '../mail/mail.service.js';
import { RedisService } from '../redis/redis.service.js';
import {
  AuthMessage,
  BCRYPT_ROUNDS,
  PASSWORD_RESET_CODE_TTL_DEFAULT,
  PASSWORD_RESET_KEY_PREFIX,
  PASSWORD_RESET_MAX_ATTEMPTS_DEFAULT,
  PASSWORD_RESET_MAX_REQUESTS_PER_HOUR_DEFAULT,
  PASSWORD_RESET_RESEND_COOLDOWN_DEFAULT,
} from './constants/auth.constant.js';
import {
  EmailVerified,
  UserEntity,
  UserStatus,
} from './entities/user.entity.js';
import { TokenService } from './token.service.js';
import type {
  ForgotPasswordResult,
  ResetPasswordResult,
} from './types/auth-user.type.js';

/**
 * 用户名 → Redis key 里的指纹。
 *
 * 用哈希而不是明文：Redis 的 RDB 会落到 volumes/redis，docker-compose 还开了**无认证**的
 * RedisInsight。存明文用户名等于把「谁在找回密码」直接摊开给人看。
 *
 * 注意**不做 trim / toLowerCase**：注册接口不归一化用户名，uk_kh_user_username 也是
 * 大小写敏感的普通唯一索引。签发与校验两处若归一化方式不一致，用户拿到的正确验证码
 * 会莫名其妙失效 —— 这里保持「原样透传」是最不容易出错的选择。
 */
const fingerprint = sha256Hex;

/** key 命名集中在四个函数里，避免各处手拼前缀拼错 */
const codeKey = (username: string) =>
  `${PASSWORD_RESET_KEY_PREFIX}:code:${fingerprint(username)}`;
const attemptsKey = (username: string) =>
  `${PASSWORD_RESET_KEY_PREFIX}:attempts:${fingerprint(username)}`;
const cooldownKey = (username: string) =>
  `${PASSWORD_RESET_KEY_PREFIX}:cooldown:${fingerprint(username)}`;
const requestsKey = (username: string) =>
  `${PASSWORD_RESET_KEY_PREFIX}:requests:${fingerprint(username)}`;

/** 小时配额的窗口长度。与 PASSWORD_RESET_MAX_REQUESTS_PER_HOUR 是同一个口径 */
const HOURLY_WINDOW_SECONDS = 60 * 60;

/** 验证码位数，与 ResetPasswordDto 的 /^\d{6}$/ 必须一致 */
const CODE_LENGTH = 6;

/**
 * 读一个「正整数」配置项，非法值一律回退到默认。
 *
 * 不能直接用 `Number(config.get(...))`：环境变量写错时得到 NaN，而 `n > NaN` 恒为 false ——
 * 一个 TTL 的笔误会让**试错次数上限静默失效**。安全开关不能有这种失败模式。
 */
function positiveInt(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = Number(config.get<string>(key, String(fallback)));
  if (!Number.isInteger(raw) || raw <= 0) {
    return fallback;
  }
  return raw;
}

/**
 * 找回密码：邮箱验证码的签发与校验。
 *
 * ## 与 EmailVerificationService 的关系
 * 两者是**平行**的两条链路，不共用状态：激活 token 换成用户注册时那次「证明邮箱是我
 * 的」，重置验证码换成忘记密码时那次「证明账号是我的」。刻意没有把 token 复用成验证码、
 * 也没有让两边的 key 相互可见 —— 激活链接能重放（幂等、拿不到任何能力），
 * 而重置验证码一旦被重放就是**凭据替换**，两者的生命周期语义完全不同。
 *
 * ## 为什么是 6 位数字 + 一堆限流，而不是长 token
 * 验证码是给人**手敲**的，长度受限于可读性，所以 10^6 的搜索空间本身就不算安全边界。
 * 真正的防线只能是「窗口短 + 次数少」这三层闸门，缺一层就会被拖垮：
 * - 单码试错 5 次（防止盯着一个验证码穷举）
 * - 重发冷却 60 秒（防止拿重发当刷新试错计数的手段）
 * - **每小时 5 次的重发配额**（关键的一层，见 auth.constant.ts 里的推导）
 *
 * ## Redis 布局（前缀 kh:password-reset，key 一律用 sha256(username)）
 * ```
 * code:<h>      → sha256Hex(验证码)  TTL 600    签发时无条件覆盖
 * attempts:<h>  → 整数计数           TTL 600    签发时无条件 SET '0'
 * cooldown:<h>  → '1'                TTL 60     抢到即代表本次可以发
 * requests:<h>  → 整数计数           TTL 3600   小时配额，重发**不**归零
 * ```
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly codeTtlSeconds: number;
  private readonly maxAttempts: number;
  private readonly cooldownSeconds: number;
  private readonly maxRequestsPerHour: number;

  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
    private readonly redis: RedisService,
    private readonly mail: MailService,
    private readonly tokenService: TokenService,
    config: ConfigService,
  ) {
    this.codeTtlSeconds = positiveInt(
      config,
      'PASSWORD_RESET_CODE_TTL_SECONDS',
      PASSWORD_RESET_CODE_TTL_DEFAULT,
    );
    this.maxAttempts = positiveInt(
      config,
      'PASSWORD_RESET_MAX_ATTEMPTS',
      PASSWORD_RESET_MAX_ATTEMPTS_DEFAULT,
    );
    this.cooldownSeconds = positiveInt(
      config,
      'PASSWORD_RESET_RESEND_COOLDOWN_SECONDS',
      PASSWORD_RESET_RESEND_COOLDOWN_DEFAULT,
    );
    this.maxRequestsPerHour = positiveInt(
      config,
      'PASSWORD_RESET_MAX_REQUESTS_PER_HOUR',
      PASSWORD_RESET_MAX_REQUESTS_PER_HOUR_DEFAULT,
    );
  }

  /**
   * 受理找回密码请求：向该账号绑定的邮箱发送 6 位验证码。
   *
   * 响应**恒定** —— 账号不存在 / 已禁用 / 没绑邮箱，一律返回同一句话。
   * 唯一会变的是 429（冷却 / 配额），而这两种限流都**不依赖任何账号信息**，
   * 所以它们出现的时机也不会泄漏账号是否存在。
   */
  async sendCode(username: string): Promise<ForgotPasswordResult> {
    // 第 1 步：Redis 不可用就直接 503，放在碰数据库之前。
    // 验证码的唯一载体就是 Redis，连不上还继续走下去只会白跑一趟。
    this.redis.assertReady();

    // 第 2、3 步：两道限流必须**先于查库**执行，且任何后续分支都不得绕过它们。
    // 一旦有分支能跳过限流（比如「没绑邮箱的账号不消耗冷却」），
    // 「第二步请求返回 201 还是 429」就成了账号是否存在 / 是否绑邮箱的纯状态码探测器。
    const cooldownLeft = await this.consumeCooldown(username);
    if (cooldownLeft !== null) {
      throw this.tooManyRequests(`发送过于频繁，请 ${cooldownLeft} 秒后再试`);
    }

    const quotaLeft = await this.consumeHourlyQuota(username);
    if (quotaLeft !== null) {
      throw this.tooManyRequests(
        `验证码请求次数已达上限，请 ${this.formatWindow(quotaLeft)}后再试`,
      );
    }

    const user = await this.em.findOne(UserEntity, {
      where: { username, deleted: false },
    });

    // 以下三种「不该发」的情况统一静默处理：限流已经过了，此时回任何错误
    // 都等于确认了这个用户名的存在。
    if (!user) {
      this.logger.warn(`找回密码：账号不存在，跳过发信 username=${username}`);
      return this.accepted();
    }
    if (user.status !== UserStatus.Enabled) {
      // 禁用账号不发信：管理员日后重新启用时，就等于把一个「密码已被请求者设定」的
      // 账号原样交出去。账号本身登不进来（login / refresh 都查 status），不发不影响任何人。
      this.logger.warn(`找回密码：账号已禁用，跳过发信 username=${username}`);
      return this.accepted();
    }
    if (!user.email) {
      // 老账号可能没有邮箱。没有投递通道就没有任何「邮箱归属」的证明，
      // 更不能反过来把 email_verified 置 1。
      this.logger.warn(`找回密码：账号没有绑定邮箱，跳过发信 username=${username}`);
      return this.accepted();
    }

    try {
      await this.issue(username, user.email);
    } catch (error) {
      // 账号查得到、限流也过了，此处回 503 同样会确认这个用户名存在。
      // 与 EmailVerificationService.resend 的取舍一致：只记 ERROR 日志，对外仍是受理成功。
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `验证码签发失败：username=${username} ${detail}（对外仍返回受理成功，避免泄漏账号是否存在）`,
      );
      return this.accepted();
    }

    return this.accepted();
  }

  /**
   * 校验验证码并重置密码。
   *
   * 成功后会：改密码 + 把 email_verified 置 1 + 吊销该用户全部令牌。
   * **不签发新令牌** —— 与注册同理，用户需要拿新密码重新登录一次。
   */
  async reset(
    username: string,
    code: string,
    newPassword: string,
  ): Promise<ResetPasswordResult> {
    const stored = await this.redis.get(codeKey(username));
    if (!stored) {
      throw this.invalidCode();
    }

    // **先自增再比对**。比对和后续写库都可能抛错，任何「先比对后自增」的顺序
    // 都存在让攻击者靠制造下游失败来绕开计数的路径。
    // 注意判据是 `>` 而不是 `>=`：用 >= 会在第 5 次比对之前就拒绝，实际只给 4 次机会。
    const attempts = await this.redis.incr(attemptsKey(username));
    if (attempts > this.maxAttempts) {
      await this.redis.del(codeKey(username), attemptsKey(username));
      this.logger.warn(
        `验证码试错超限，已作废该验证码：username=${username} attempts=${attempts}`,
      );
      throw this.invalidCode();
    }

    // 用普通 === 比较两个 sha256 摘要，不需要 timingSafeEqual：
    // 左边是攻击者输入的哈希，SHA-256 的雪崩效应使它无法构造前缀匹配，
    // 逐字节的时间侧信道拿不到任何有用信息。
    // （顺带说明：对 6 位数字码来说，「存哈希」对**离线**攻击的保护约等于零 —— 10^6
    //   空间秒破。保留哈希是为了与 kh_refresh_token / 激活 token 的约定一致，
    //   以及避免 dump 被人肉眼直接读走验证码，而不是因为它不可逆。）
    if (sha256Hex(code) !== stored) {
      throw this.invalidCode();
    }

    // 原子的「取出即删除」，用它抢占这个验证码。
    // 放在比对**之后**：如果直接拿 GETDEL 当首次读取，一次输错就会连验证码一起吃掉。
    // 返回 null 说明并发的另一个请求已经抢先消费掉了，否则两个请求会各写一次密码。
    const claimed = await this.redis.getDel(codeKey(username));
    if (claimed === null) {
      throw this.invalidCode();
    }

    const user = await this.em.findOne(UserEntity, {
      where: { username, deleted: false },
    });
    // 复查 status：发码时启用、用码时已被禁用的账号不该被改密
    if (!user || user.status !== UserStatus.Enabled) {
      await this.redis.del(attemptsKey(username));
      throw this.invalidCode();
    }

    // bcrypt 放在验证码校验**之后**。bcryptjs 是纯 JS 实现，cost 10 约 200-300ms，
    // 本项目没有全局限流器，放在前面就等于开了个无需认证的 CPU 放大接口。
    // 先算好再动库，是为了让下面「吊销 → 改密」之间的失败窗口尽可能短。
    const passwordHash = await hash(newPassword, BCRYPT_ROUNDS);

    // **先吊销会话，后改密码**。两步不在同一个事务里，必须显式选一个失败窗口：
    // - 这里失败：用户被登出但密码没变 —— 表现吵闹、用户重试即可，攻击者没得到新东西；
    // - 反过来失败：被盗的 refresh token 仍然可用、而密码已经变了 —— 静默，
    //   且正是「账号可能已被盗，所以我要改密码」这个场景最怕的结果。
    //
    // revokeAllForUser 内部已经自增了 kh_user.token_version，**不要再调 bumpTokenVersion**。
    await this.tokenService.revokeAllForUser(user.id);

    // 必须用 update 而不是 save：user 实体是在上面自增 token_version **之前**读出来的，
    // save(user) 会把过期的 tokenVersion 写回去，等于把刚刚吊销掉的 access token 全部复活。
    // 因此这里显式挑字段，tokenVersion 绝不出现在这个对象里。
    await this.em.update(UserEntity, user.id, {
      password: passwordHash,
      // 能收到验证码本身就证明了邮箱归属，与点激活链接等价。
      // 顺手置 1 是为了把「注册了但没激活、因此永远登不进来」的用户捞出来 ——
      // 不这么做的话，他们重置完密码仍然会撞上 403，陷入死循环。
      emailVerified: EmailVerified.Yes,
    });

    // 验证码本身已被 getDel 消费，这里清掉的是配套的试错计数器
    await this.redis.del(attemptsKey(username));

    this.logger.log(`密码已重置：user=${user.username} id=${user.id}`);
    return { success: true, message: AuthMessage.ResetPasswordSuccess };
  }

  /**
   * 签发验证码并发送邮件。
   *
   * 调用方需自行 try/catch：Redis 写入失败会抛 503。
   * 无邮箱的账号由调用方提前挡掉，这里只处理「有邮箱」的分支。
   */
  private async issue(username: string, email: string): Promise<void> {
    const ttlSeconds = this.codeTtlSeconds;
    const code = this.generateCode();

    // 覆盖式写入：同一用户重发时旧验证码立刻失效。
    // 这比多个验证码并存更安全，也符合用户直觉（「我刚点的重发」就该是最新的那封）。
    await this.redis.set(codeKey(username), sha256Hex(code), ttlSeconds);
    // 重发即重置试错计数（否则用户手滑 4 次之后重发一次只剩 1 次机会，很反直觉）。
    // ⚠️ 这里必须用无条件 set，**不能**用 setIfAbsent：
    // INCR 对不存在的 key 会创建它且**不带 TTL**，一旦 attempts key 因任何原因先消失，
    // setIfAbsent 就再也补不上 TTL，那个计数器会永不过期地累积下去，
    // 该用户从此每次校验都直接判定超限 —— 永久锁死，只能手工 DEL 才能恢复。
    await this.redis.set(attemptsKey(username), '0', ttlSeconds);

    // 邮件里只有验证码，没有任何链接。见 MailService.buildResetText 的说明。
    await this.mail.sendPasswordResetCode(
      email,
      code,
      username,
      Math.max(1, Math.ceil(ttlSeconds / 60)),
    );
  }

  /**
   * 生成 6 位数字验证码。
   *
   * 用 crypto.randomInt 而不是 Math.random：前者是 CSPRNG，且内部走拒绝采样，
   * 不像 `randomBytes(...) % 1000000` 那样存在模偏。
   * padStart 保证前导零不被吃掉（`012345` 必须原样是 6 位）。
   */
  private generateCode(): string {
    return randomInt(0, 10 ** CODE_LENGTH)
      .toString()
      .padStart(CODE_LENGTH, '0');
  }

  /**
   * 抢占冷却位。
   *
   * 与 EmailVerificationService.consumeCooldown 同构（那边是按 username 的哈希做 key，
   * 这边是按 username）。不共用实现是因为 key 的构造口径不同，抽出来反而要看两个参数。
   *
   * @returns null 表示抢到了；否则返回剩余秒数
   */
  private async consumeCooldown(username: string): Promise<number | null> {
    const key = cooldownKey(username);
    const acquired = await this.redis.setIfAbsent(key, '1', this.cooldownSeconds);
    if (acquired) {
      return null;
    }

    const ttl = await this.redis.ttl(key);
    // ttl 为 -1（无过期）或 -2（已消失）时兜底成 1，避免把负数或 0 丢给用户
    return ttl > 0 ? ttl : 1;
  }

  /**
   * 消耗小时配额。
   *
   * 窗口是「首次请求起算的固定 3600 秒」，不是滑动窗口 —— 实现简单，且对本用途足够：
   * 它要挡住的是「持续不断地爆破」，而不是精确的速率整形。
   *
   * 注意这个 key **不会**在重发时归零（与 attempts 相反），否则它就和 60 秒冷却没区别了。
   *
   * @returns null 表示还有额度；否则返回窗口剩余秒数
   */
  private async consumeHourlyQuota(username: string): Promise<number | null> {
    const key = requestsKey(username);
    // setIfAbsent 每次请求都会执行：key 缺失时必然在这里被补上 TTL，
    // 因此紧随其后的 incr 永远不会作用在一个「没有过期时间」的 key 上。
    // （这正是 RedisService.incr 注释里警告的那类陷阱，也是这里唯一安全的写法。）
    await this.redis.setIfAbsent(key, '0', HOURLY_WINDOW_SECONDS);

    const count = await this.redis.incr(key);
    if (count <= this.maxRequestsPerHour) {
      return null;
    }

    const ttl = await this.redis.ttl(key);
    return ttl > 0 ? ttl : 1;
  }

  /** 恒定响应。所有「静默跳过发信」的分支都走这里 */
  private accepted(): ForgotPasswordResult {
    return { success: true, message: AuthMessage.ForgotPasswordAccepted };
  }

  /**
   * 验证码相关的**所有**失败原因共用这一个异常。
   *
   * 没申请过 / 已过期 / 输入错误 / 试错超限 / 并发抢先 —— 对外必须是同一句话，
   * 否则这个接口就成了「该账号是否存在、是否绑了邮箱」的探测器。
   */
  private invalidCode(): BadRequestException {
    return new BadRequestException(AuthMessage.ResetPasswordCodeInvalid);
  }

  /** @nestjs/common 11.2 没有导出 TooManyRequestsException，只能用 HttpException + 枚举 */
  private tooManyRequests(message: string): HttpException {
    return new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
  }

  /** 把剩余秒数转成用户能读懂的说法 */
  private formatWindow(seconds: number): string {
    return seconds >= 60 ? `${Math.ceil(seconds / 60)} 分钟` : `${seconds} 秒`;
  }
}
