import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { compare, hash } from 'bcryptjs';
import { EntityManager } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { AuthMessage, BCRYPT_ROUNDS } from './constants/auth.constant.js';
import { RoleCode } from './constants/role.constant.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { LogoutDto } from './dto/logout.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { EmailVerificationService } from './email-verification.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { RoleEntity } from './entities/role.entity.js';
import { UserRoleEntity } from './entities/user-role.entity.js';
import {
  EmailVerified,
  UserEntity,
  UserStatus,
} from './entities/user.entity.js';
import { TokenService } from './token.service.js';
import { UserAccessorService } from './user-accessor.service.js';
import {
  normalizeEmail,
  rethrowUserUniqueViolation,
} from './user-identity.util.js';
import type {
  AuthResult,
  AuthUser,
  ChangePasswordResult,
  RegisterResult,
} from './types/auth-user.type.js';
import type { TokenContext } from './types/token-context.type.js';

/**
 * 用户不存在时也拿它跑一次 bcrypt，让「用户不存在」和「密码错误」的响应耗时接近，
 * 避免通过时间差枚举出系统里有哪些用户名。
 * （内容就是 123456 的哈希，仅用于消耗等量 CPU）
 */
const DUMMY_PASSWORD_HASH =
  '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi';

/** 注册 / 登录 / 刷新 / 登出 / 当前用户 / 邮箱激活 / 找回密码 / 修改密码 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
    private readonly tokenService: TokenService,
    private readonly emailVerification: EmailVerificationService,
    private readonly passwordReset: PasswordResetService,
    private readonly accessor: UserAccessorService,
  ) {}

  /**
   * 注册：建用户（email_verified = 0）后发激活邮件，**不签发令牌**。
   *
   * 用户必须点完邮件里的链接才能登录（见 login 的邮箱校验），所以注册的产物
   * 是一封邮件而不是一次登录。新用户固定授予 ROLE_USER，不接受客户端传入任何角色。
   *
   * 顺序刻意是「先落库 → 再写 Redis → 最后发信」，理由是失败后的可恢复性：
   * 先写 Redis 再插库的话，插库失败会留下一个指向不存在用户的 token；
   * 反过来最坏只是「用户存在但没 token」，而这个状态有现成的恢复通道（重发接口）。
   */
  async register(dto: RegisterDto): Promise<RegisterResult> {
    // 第 1 步：Redis 不可用就不建号（放在碰数据库之前）。
    // 否则建出来的是既不能登录、又激活不了的僵尸账号，比直接失败更糟。
    this.emailVerification.assertAvailable();

    const email = normalizeEmail(dto.email);

    if (
      await this.em.findOne(UserEntity, {
        where: { username: dto.username, deleted: false },
      })
    ) {
      throw new BadRequestException(AuthMessage.UsernameAlreadyTaken);
    }
    if (
      await this.em.findOne(UserEntity, {
        where: { email, deleted: false },
      })
    ) {
      throw new BadRequestException(AuthMessage.EmailAlreadyRegistered);
    }

    const defaultRole = await this.em.findOne(RoleEntity, {
      where: { roleCode: RoleCode.User },
    });
    if (!defaultRole) {
      throw new Error(
        `预置角色 ${RoleCode.User} 不存在，请先执行 init-scripts/postgresql/init.sql`,
      );
    }

    const user = this.em.create(UserEntity, {
      id: nextSnowflakeId(),
      username: dto.username,
      password: await hash(dto.password, BCRYPT_ROUNDS),
      email,
      emailVerified: EmailVerified.No,
      realName: dto.realName ?? null,
      avatar: null,
      status: UserStatus.Enabled,
      // 必须显式给 0：库里有 default，但内存实体的 undefined 会被写进 JWT 载荷，
      // 与库中的 0 比对不上，会导致用户之后拿到令牌时第一次请求就被判为登录失效
      tokenVersion: 0,
      // 注册不再等于登录，没有「最后登录时间」可言
      lastLoginAt: null,
      deleted: false,
    });

    try {
      // 用户与角色关联必须同事务，否则失败时会留下一个没有任何角色的用户
      await this.em.transaction(async (tx) => {
        await tx.insert(UserEntity, user);
        await tx.insert(UserRoleEntity, {
          id: nextSnowflakeId(),
          userId: user.id,
          roleId: defaultRole.id,
        });
      });
    } catch (error) {
      // 并发注册时上面的预检会漏，靠唯一索引兜底；按索引名区分是哪一个撞了。
      // 与管理员后台建号共用同一个翻译函数，保证两条链路话术同源。
      rethrowUserUniqueViolation(error);
    }

    // 第 6 步：账号已经建好，决策不可逆。此处再失败（Redis 恰好掉线 / SMTP 超时）
    // 只记 ERROR 日志、对外仍返回受理成功 —— 返回 5xx 会让前端提示「注册失败」，
    // 用户重试只会撞上「用户名已存在」，是个把用户困死的陷阱。
    // 恢复通道是 POST /auth/resend-verification。
    try {
      await this.emailVerification.issueAndSend(user);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `激活邮件签发失败，账号已创建，可用重发接口恢复：user=${user.username} id=${user.id} ${detail}`,
      );
    }

    return {
      success: true,
      id: user.id,
      username: user.username,
      email,
      message: AuthMessage.RegisterAccepted,
    };
  }

  /** 登录：校验密码后签发令牌 */
  async login(dto: LoginDto, context: TokenContext): Promise<AuthResult> {
    const user = await this.em.findOne(UserEntity, {
      where: { username: dto.username, deleted: false },
    });

    // 无论用户是否存在都跑一次 bcrypt，响应体与耗时保持一致，避免用户名枚举
    const passwordMatches = await compare(
      dto.password,
      user?.password ?? DUMMY_PASSWORD_HASH,
    );
    if (!user || !passwordMatches) {
      throw new UnauthorizedException('用户名或密码错误');
    }

    if (user.status !== UserStatus.Enabled) {
      throw new UnauthorizedException('账号已被禁用');
    }

    // 密码已验证通过才判邮箱 —— 放在这之前的话，攻击者不需要密码就能探出
    // 「该用户名存在且未验证」，会破坏上面 DUMMY_PASSWORD_HASH 那套防枚举设计。
    this.assertEmailVerified(user);

    const roles = await this.loadRoleCodes(user.id);
    const now = new Date();
    // 用 update 而不是 save，避免把整个实体（含 password）回写覆盖
    await this.em.update(UserEntity, user.id, { lastLoginAt: now });
    user.lastLoginAt = now;

    const pair = await this.tokenService.issueTokenPair(
      this.toTokenSubject(user, roles),
      context,
    );
    return { ...pair, user: this.toAuthUser(user, roles) };
  }

  /**
   * 刷新令牌：轮换语义 —— 旧 refreshToken 立即失效并指向新令牌。
   * 角色在此处重新查库，因此改角色最迟在一次刷新后生效。
   */
  async refresh(rawToken: string, context: TokenContext): Promise<AuthResult> {
    const { userId, rowId } =
      await this.tokenService.consumeRefreshToken(rawToken);

    const user = await this.em.findOne(UserEntity, {
      where: { id: userId, deleted: false },
    });
    if (!user) {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }
    if (user.status !== UserStatus.Enabled) {
      throw new UnauthorizedException('账号已被禁用');
    }
    // 正常情况下不可达（未验证用户根本拿不到 refresh token），但这样能保证
    // 「未验证用户绝不可能持有可用令牌」这条不变量在任何路径下都成立 ——
    // 例如管理员手工把某账号的 email_verified 改回 0 强制重新验证。
    this.assertEmailVerified(user);

    const roles = await this.loadRoleCodes(user.id);
    const pair = await this.tokenService.issueTokenPair(
      this.toTokenSubject(user, roles),
      context,
      rowId,
    );
    return { ...pair, user: this.toAuthUser(user, roles) };
  }

  /** 校验激活邮件里的 token（幂等，重复点击不算失败） */
  verifyEmail(rawToken: string) {
    return this.emailVerification.verify(rawToken);
  }

  /** 重发激活邮件。响应恒定，不反映账号是否存在 */
  resendVerification(username: string) {
    return this.emailVerification.resend(username);
  }

  /** 找回密码：向绑定邮箱发送验证码。响应恒定，不反映账号是否存在 */
  forgotPassword(dto: ForgotPasswordDto) {
    return this.passwordReset.sendCode(dto.username);
  }

  /** 重置密码：校验验证码后改密，并让该用户全部已签发令牌失效 */
  resetPassword(dto: ResetPasswordDto) {
    return this.passwordReset.reset(dto.username, dto.code, dto.newPassword);
  }

  /**
   * 修改密码：已登录状态下凭**当前密码**改自己的密码。
   *
   * 与 resetPassword 是两条独立链路，凭据强度不同：这条证明的是「我持有旧密码」，
   * 那条证明的是「我能收到绑定邮箱的验证码」。因此限流、生命周期、失败语义都不能复用，
   * 唯一相同的只有「成功后全部下线」这个结果。
   *
   * 成功即吊销该用户**全部**已签发令牌，且不签发新令牌 —— 与重置密码一致，
   * 用户需用新密码重新登录一次。
   */
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
  ): Promise<ChangePasswordResult> {
    const user = await this.em.findOne(UserEntity, {
      where: { id: userId, deleted: false },
    });
    // 守卫已经比对过 status 与 tokenVersion；这里再查一次是为了覆盖
    // 「请求在途时被管理员禁用」的 TOCTOU，与 refresh 里的复查同构。
    if (!user || user.status !== UserStatus.Enabled) {
      throw new UnauthorizedException('账号不存在或已被禁用');
    }

    // 不做 login 那套 DUMMY_PASSWORD_HASH 等时比较：那套是为了防「用户名枚举」，
    // 而这里的调用者已经通过鉴权，不存在需要隐藏的用户名面。
    if (!(await compare(dto.oldPassword, user.password))) {
      throw new BadRequestException(AuthMessage.OldPasswordIncorrect);
    }
    if (dto.newPassword === dto.oldPassword) {
      throw new BadRequestException(AuthMessage.NewPasswordSameAsOld);
    }

    // bcrypt 放在全部校验之后：cost 10 约 200-300ms，先挡掉注定失败的请求再花 CPU
    const passwordHash = await hash(dto.newPassword, BCRYPT_ROUNDS);

    // 先吊销会话、后改密码 —— 与 PasswordResetService.reset 同一失败窗口取舍：
    // 这个方向失败是「被登出但密码没变」（吵闹、可重试），
    // 反方向是「被盗的 refresh token 仍有效而密码已变」（静默，且正是本功能要防的场景）。
    // revokeAllForUser 内部已自增 token_version，**不要再调 bumpTokenVersion**。
    await this.tokenService.revokeAllForUser(user.id);

    // 必须用 update 而不是 save：user 是自增 token_version **之前**读出来的，
    // save(user) 会把过期的 tokenVersion 写回去，等于把刚吊销的 access token 全部复活。
    // 因此这里只挑 password 一个字段，tokenVersion 绝不出现在这个对象里。
    await this.em.update(UserEntity, user.id, { password: passwordHash });

    this.logger.log(`密码已修改：user=${user.username} id=${user.id}`);

    return { success: true, message: AuthMessage.PasswordChanged };
  }

  /**
   * 登出：吊销刷新令牌，并让该用户已签发的 access token 立即失效。
   *
   * 幂等，令牌不存在也返回成功，避免把登出接口变成令牌有效性探测器。
   * allDevices 只影响**刷新令牌**是否全吊销；access token 的失效粒度始终是整用户，
   * 其他设备会收到一次 401 再靠 refresh 无感恢复（它们的刷新令牌仍在）。
   */
  async logout(dto: LogoutDto): Promise<{ success: true }> {
    await this.tokenService.revokeRefreshToken(
      dto.refreshToken,
      dto.allDevices ?? false,
    );
    return { success: true };
  }

  /** 当前登录用户信息；账号被禁用或删除后即使令牌未过期也拒绝 */
  async profile(userId: string): Promise<AuthUser> {
    const user = await this.em.findOne(UserEntity, {
      where: { id: userId, deleted: false },
    });
    if (!user || user.status !== UserStatus.Enabled) {
      throw new UnauthorizedException('账号不存在或已被禁用');
    }

    return this.toAuthUser(user, await this.loadRoleCodes(user.id));
  }

  /**
   * 邮箱未激活则拒绝登录，返回 **403** 而非 401。
   *
   * 三点理由：
   * 1. 语义上凭据完全正确、账号也确实存在，属于「已识别身份但无权继续」；
   * 2. 本项目已把 401 定义为前端「清令牌 / 跳登录页 / 走 401→refresh→重试」的信号，
   *    塞进 401 会让前端误判成令牌问题；
   * 3. 全局 RolesGuard 对 @Public() 路由先短路，所以 /auth/login 的 403
   *    **只可能**来自这里 —— 前端用「路径 + 状态码」就能唯一确定分支，不必解析文案。
   */
  private assertEmailVerified(user: UserEntity): void {
    if (user.emailVerified !== EmailVerified.Yes) {
      throw new ForbiddenException(AuthMessage.EmailNotVerified);
    }
  }

  /**
   * 查询用户持有的角色编码（只取启用中的角色）。
   *
   * 实现已挪到 UserAccessorService —— 管理员链路也要回答同一个问题，
   * 而其中的「启用过滤」是授权谓词，绝不能有两份。
   */
  private loadRoleCodes(userId: string): Promise<RoleCode[]> {
    return this.accessor.loadRoleCodes(userId);
  }

  /** 组装 JWT 载荷用的主体 */
  private toTokenSubject(user: UserEntity, roles: RoleCode[]) {
    return this.accessor.toTokenSubject(user, roles);
  }

  /** 显式挑字段构造响应 —— 绝不能用 { ...user }，否则 password 会被序列化出去 */
  private toAuthUser(user: UserEntity, roles: RoleCode[]): AuthUser {
    return this.accessor.toAuthUser(user, roles);
  }
}
