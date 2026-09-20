import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { compare, hash } from 'bcryptjs';
import { EntityManager } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { BCRYPT_ROUNDS } from './constants/auth.constant.js';
import { RoleCode } from './constants/role.constant.js';
import { LoginDto } from './dto/login.dto.js';
import { LogoutDto } from './dto/logout.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { RoleEntity } from './entities/role.entity.js';
import { UserRoleEntity } from './entities/user-role.entity.js';
import { UserEntity, UserStatus } from './entities/user.entity.js';
import { TokenService } from './token.service.js';
import type { AuthResult, AuthUser } from './types/auth-user.type.js';
import type { TokenContext } from './types/token-context.type.js';

/**
 * 用户不存在时也拿它跑一次 bcrypt，让「用户不存在」和「密码错误」的响应耗时接近，
 * 避免通过时间差枚举出系统里有哪些用户名。
 * （内容就是 123456 的哈希，仅用于消耗等量 CPU）
 */
const DUMMY_PASSWORD_HASH =
  '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi';

/** Postgres 唯一键冲突错误码 */
const PG_UNIQUE_VIOLATION = '23505';

/** 判断是否为 Postgres 唯一键冲突 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

/** 注册 / 登录 / 刷新 / 登出 / 当前用户 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
    private readonly tokenService: TokenService,
  ) {}

  /**
   * 注册：建用户并直接签发令牌（第一期简化注册，注册即启用）。
   * 新用户固定授予 ROLE_USER，不接受客户端传入任何角色。
   */
  async register(dto: RegisterDto, context: TokenContext): Promise<AuthResult> {
    const existing = await this.em.findOne(UserEntity, {
      where: { username: dto.username, deleted: false },
    });
    if (existing) {
      throw new BadRequestException('用户名已存在');
    }

    const defaultRole = await this.em.findOne(RoleEntity, {
      where: { roleCode: RoleCode.User },
    });
    if (!defaultRole) {
      throw new Error(
        `预置角色 ${RoleCode.User} 不存在，请先执行 init-scripts/postgresql/init.sql`,
      );
    }

    const now = new Date();
    const user = this.em.create(UserEntity, {
      id: nextSnowflakeId(),
      username: dto.username,
      password: await hash(dto.password, BCRYPT_ROUNDS),
      email: dto.email ?? null,
      realName: dto.realName ?? null,
      avatar: null,
      status: UserStatus.Enabled,
      // 必须显式给 0：库里有 default，但内存实体的 undefined 会被写进 JWT 载荷，
      // 与库中的 0 比对不上，会导致新用户拿到令牌后第一次请求就被判为登录失效
      tokenVersion: 0,
      lastLoginAt: now,
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
      // 并发注册同名用户时预检会漏，靠唯一索引兜底
      if (isUniqueViolation(error)) {
        throw new BadRequestException('用户名已存在');
      }
      throw error;
    }

    const pair = await this.tokenService.issueTokenPair(
      this.toTokenSubject(user, [RoleCode.User]),
      context,
    );
    return { ...pair, user: this.toAuthUser(user, [RoleCode.User]) };
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

    const roles = await this.loadRoleCodes(user.id);
    const pair = await this.tokenService.issueTokenPair(
      this.toTokenSubject(user, roles),
      context,
      rowId,
    );
    return { ...pair, user: this.toAuthUser(user, roles) };
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

  /** 查询用户持有的角色编码（只取启用中的角色） */
  private async loadRoleCodes(userId: string): Promise<RoleCode[]> {
    const roles = await this.em
      .createQueryBuilder(RoleEntity, 'role')
      .innerJoin(UserRoleEntity, 'ur', 'ur.role_id = role.id')
      .where('ur.user_id = :userId', { userId })
      .andWhere('role.status = :status', { status: 1 })
      .getMany();

    return roles.map((role) => role.roleCode as RoleCode);
  }

  /** 组装 JWT 载荷用的主体 */
  private toTokenSubject(user: UserEntity, roles: RoleCode[]) {
    return {
      id: user.id,
      username: user.username,
      name: user.realName?.trim() || user.username,
      roles,
      tokenVersion: user.tokenVersion,
    };
  }

  /** 显式挑字段构造响应 —— 绝不能用 { ...user }，否则 password 会被序列化出去 */
  private toAuthUser(user: UserEntity, roles: RoleCode[]): AuthUser {
    return {
      id: user.id,
      username: user.username,
      email: user.email ?? null,
      realName: user.realName ?? null,
      avatar: user.avatar ?? null,
      roles,
      lastLoginAt: user.lastLoginAt ?? null,
      createdAt: user.createdAt,
    };
  }
}
