import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectEntityManager } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { EntityManager } from 'typeorm';
import { sha256Hex } from '../common/hash.js';
import {
  AuthMessage,
  EMAIL_VERIFY_KEY_PREFIX,
  EMAIL_VERIFY_RESEND_COOLDOWN_DEFAULT,
  EMAIL_VERIFY_TOKEN_TTL_DEFAULT,
} from './constants/auth.constant.js';
import { EmailVerified, UserEntity } from './entities/user.entity.js';
import { MailService } from '../mail/mail.service.js';
import { RedisService } from '../redis/redis.service.js';
import type {
  ResendVerificationResult,
  VerifyEmailResult,
} from './types/auth-user.type.js';

/** key 命名集中在三个函数里，避免各处手拼前缀拼错 */
const tokenKey = (tokenHash: string) =>
  `${EMAIL_VERIFY_KEY_PREFIX}:token:${tokenHash}`;
const userKey = (userId: string) => `${EMAIL_VERIFY_KEY_PREFIX}:user:${userId}`;
const cooldownKey = (username: string) =>
  `${EMAIL_VERIFY_KEY_PREFIX}:cooldown:${sha256Hex(username)}`;

/**
 * 邮箱激活：token 的签发、校验与重发。
 *
 * 从 AuthService 拆出来独立成服务，是因为这块有自己完整的一套关注点
 * （token 生成 / Redis 布局 / 幂等语义 / 限流 / 组链接），塞进 AuthService 会让它
 * 从「登录注册的主流程」膨胀成四百行、同时混着令牌与邮件两套东西。
 *
 * ## 为什么 token 放 Redis 而不是落库或做 JWT
 * 它需要「可作废、可被重发覆盖、能限流、24h 后自然消失」，这三条 Redis 天生就支持。
 * JWT 自包含且撤销不了；落库则要自己写清理任务。它也只存 SHA-256 哈希，
 * 与 kh_refresh_token 的「只存哈希」约定一致 —— Redis 的 RDB 会落到 volumes/redis，
 * 而且 docker-compose 还开了无认证的 RedisInsight，存原文等于谁连上都能激活任意账号。
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);
  private readonly tokenTtlSeconds: number;
  private readonly cooldownSeconds: number;
  private readonly verifyUrl: string;

  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
    private readonly redis: RedisService,
    private readonly mail: MailService,
    config: ConfigService,
  ) {
    this.tokenTtlSeconds = Number(
      config.get<string>(
        'EMAIL_VERIFY_TOKEN_TTL_SECONDS',
        String(EMAIL_VERIFY_TOKEN_TTL_DEFAULT),
      ),
    );
    this.cooldownSeconds = Number(
      config.get<string>(
        'EMAIL_VERIFY_RESEND_COOLDOWN_SECONDS',
        String(EMAIL_VERIFY_RESEND_COOLDOWN_DEFAULT),
      ),
    );
    // 邮件链接的完整基地址，?token= 由代码拼。日后有了前端页面，把它指向前端即可，
    // 不必改代码（前端页面再回调本接口）
    this.verifyUrl = config.get<string>(
      'EMAIL_VERIFY_URL',
      'http://localhost:3000/auth/verify-email',
    );
  }

  /**
   * 注册前的可用性预检：Redis 不可用就直接 503，**在碰数据库之前**。
   *
   * 注册的唯一产物就是「一封带着 Redis token 的邮件」。Redis 不可用时若照样建号，
   * 得到的是一个既无法登录、又激活不了的僵尸账号 —— 比直接失败更糟。
   */
  assertAvailable(): void {
    this.redis.assertReady();
  }

  /**
   * 签发激活 token 并发送邮件。
   *
   * 同一用户重复调用会**覆盖**旧 token：旧链接立刻失效。这比多个链接并存更安全，
   * 也符合用户直觉（「我刚点的重发」就该是最新的那封）。
   *
   * 调用方需自行 try/catch：Redis 写入失败会抛 503。
   */
  async issueAndSend(
    user: Pick<UserEntity, 'id' | 'username' | 'email'>,
  ): Promise<void> {
    if (!user.email) {
      // 理论上不可达（注册接口强制要邮箱）。老账号可能没有，重发时静默跳过。
      this.logger.warn(
        `用户没有邮箱，跳过激活邮件：user=${user.username} id=${user.id}`,
      );
      return;
    }

    // 32 字节随机数转 base64url（43 字符）：URL 安全，放进 ?token= 不需要百分号转义
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = sha256Hex(rawToken);

    // 先让旧 token 失效。不做 MULTI：中间窗口只有微秒级，最坏是「旧的已失效、新的还没写进去」，
    // 用户再点一次重发即可恢复。要强一致可在 RedisService 上加 multi() 包装。
    const previousHash = await this.redis.get(userKey(user.id));
    if (previousHash) {
      await this.redis.del(tokenKey(previousHash));
    }

    await this.redis.set(tokenKey(tokenHash), user.id, this.tokenTtlSeconds);
    await this.redis.set(userKey(user.id), tokenHash, this.tokenTtlSeconds);

    const link = this.buildLink(rawToken);
    await this.mail.sendVerificationEmail(user.email, link, user.username);
  }

  /**
   * 校验激活 token 并置 email_verified = 1。
   *
   * **刻意不删 Redis 里的 token**（不用 GETDEL）：Gmail、企业邮件网关会**预取**邮件里的
   * 链接，删掉就等于让机器人在用户点击前把 token 吃掉，用户自己点反而得到「链接已失效」。
   * 而本 token 的唯一能力是「把某个账号标记为邮箱已验证」——该操作幂等、不可逆、
   * 且不能登录 / 改邮箱 / 解绑，重放它没有任何后果。所以保留到 TTL 到期比严格一次性更健壮。
   */
  async verify(rawToken: string): Promise<VerifyEmailResult> {
    const tokenHash = sha256Hex(rawToken);
    const userId = await this.redis.get(tokenKey(tokenHash));

    if (!userId) {
      throw new BadRequestException(AuthMessage.EmailVerifyLinkInvalid);
    }

    const user = await this.em.findOne(UserEntity, {
      where: { id: userId, deleted: false },
    });

    if (!user) {
      // token 还在、用户没了 —— 典型场景是 `pnpm db:reset` 清了库而 Redis 是独立持久化的。
      // 顺手清掉这对残留 key，否则它会一直挂到 TTL 到期。
      await this.redis.del(tokenKey(tokenHash), userKey(userId));
      throw new BadRequestException(AuthMessage.EmailVerifyLinkInvalid);
    }

    if (user.emailVerified === EmailVerified.Yes) {
      // 重复点击 / 邮件客户端预取。不写库。
      return {
        success: true,
        username: user.username,
        email: user.email ?? null,
        alreadyVerified: true,
        message: AuthMessage.EmailAlreadyVerified,
      };
    }

    // 用 update 而不是 save：避免把整个实体（含 password）回写覆盖
    await this.em.update(UserEntity, user.id, {
      emailVerified: EmailVerified.Yes,
    });

    return {
      success: true,
      username: user.username,
      email: user.email ?? null,
      alreadyVerified: false,
      message: AuthMessage.EmailVerifySuccess,
    };
  }

  /**
   * 重发激活邮件。
   *
   * 响应**恒定**：账号不存在 / 已激活 / 没有邮箱，一律返回同一句话。
   * 一旦区分，这个接口就成了「某账号是否已激活」的公开枚举器。
   *
   * 冷却必须在这之前先做，且不依赖任何账号信息 —— 否则枚举者仍能从
   * 「429 出现的时机」反推出用户名是否存在。
   */
  async resend(username: string): Promise<ResendVerificationResult> {
    const remaining = await this.consumeCooldown(username);
    if (remaining !== null) {
      // @nestjs/common 11.2 没有导出 TooManyRequestsException，只能用 HttpException + 枚举
      throw new HttpException(
        `发送过于频繁，请 ${remaining} 秒后再试`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.em.findOne(UserEntity, {
      where: { username, deleted: false },
    });

    // 三种「不该发」的情况统一静默处理。这里**不能**抛 503：
    // 冷却已通过、账号又查得到，此时回 503 就等于确认「这个用户名存在」。
    if (user && user.emailVerified !== EmailVerified.Yes) {
      try {
        await this.issueAndSend(user);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `重发激活邮件失败：user=${username} ${detail}（对外仍返回受理成功，避免泄漏账号是否存在）`,
        );
      }
    }

    return { success: true, message: AuthMessage.ResendAccepted };
  }

  /**
   * 抢占冷却位。
   *
   * @returns null 表示抢到了；否则返回剩余秒数
   */
  private async consumeCooldown(username: string): Promise<number | null> {
    // 按 username 的哈希而不是 userId：账号不存在时冷却同样生效，
    // 否则「能不能连续请求」本身就成了用户名是否存在的信号
    const key = cooldownKey(username);
    const acquired = await this.redis.setIfAbsent(
      key,
      '1',
      this.cooldownSeconds,
    );
    if (acquired) {
      return null;
    }

    const ttl = await this.redis.ttl(key);
    // ttl 为 -1（无过期）或 -2（已消失）时兜底成 1，避免把负数或 0 丢给用户
    return ttl > 0 ? ttl : 1;
  }

  private buildLink(rawToken: string): string {
    const separator = this.verifyUrl.includes('?') ? '&' : '?';
    return `${this.verifyUrl}${separator}token=${encodeURIComponent(rawToken)}`;
  }
}
