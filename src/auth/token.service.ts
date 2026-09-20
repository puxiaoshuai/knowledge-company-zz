import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { JwtSignOptions } from '@nestjs/jwt';
import { InjectEntityManager } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { RefreshTokenEntity } from './entities/refresh-token.entity.js';
import { UserEntity, UserStatus } from './entities/user.entity.js';
import type { AuthenticatedUser } from './types/authenticated-user.type.js';
import type {
  DecodedJwtPayload,
  JwtPayload,
} from './types/jwt-payload.type.js';
import type {
  TokenContext,
  TokenPair,
  TokenSubject,
} from './types/token-context.type.js';

/** 刷新令牌原文 → SHA-256 hex（64 字符）。库里只存哈希，泄库也无法直接使用 */
function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/** 读取必填的 JWT secret；缺失或仍是 .env.example 占位值时直接启动失败，避免用弱密钥上线 */
function requireSecret(config: ConfigService, key: string): string {
  const value = config.get<string>(key, '').trim();
  if (!value) {
    throw new Error(
      `缺少环境变量 ${key}。生成方式：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  if (value.startsWith('change-me')) {
    throw new Error(
      `环境变量 ${key} 仍是 .env.example 里的占位值，请换成随机密钥`,
    );
  }
  return value;
}

/**
 * 令牌服务：签发、校验、轮换、吊销。
 *
 * - access token 不落库，有效期默认 2h
 * - refresh token 落 kh_refresh_token（只存哈希），有效期默认 7d，可吊销
 * - 两者用**不同 secret** 签发，并各自带 type 声明，双重防止互相冒用
 *
 * access token 本身不可单独吊销，但载荷里带着 kh_user.token_version 的快照，
 * 校验时与库里的当前值比对一次（见 verifyAccessToken），因此把版本号自增一次
 * 就能让该用户已签发的全部 access token 立即失效。
 */
@Injectable()
export class TokenService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessExpiresIn: JwtSignOptions['expiresIn'];
  private readonly refreshExpiresIn: JwtSignOptions['expiresIn'];

  constructor(
    private readonly jwt: JwtService,
    @InjectEntityManager()
    private readonly em: EntityManager,
    config: ConfigService,
  ) {
    this.accessSecret = requireSecret(config, 'JWT_ACCESS_SECRET');
    this.refreshSecret = requireSecret(config, 'JWT_REFRESH_SECRET');
    // 配置里是 '2h' / '7d' 这类时长字符串，交给 jsonwebtoken 自行解析
    this.accessExpiresIn = config.get<string>(
      'JWT_ACCESS_EXPIRES_IN',
      '2h',
    ) as JwtSignOptions['expiresIn'];
    this.refreshExpiresIn = config.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
      '7d',
    ) as JwtSignOptions['expiresIn'];

    if (this.accessSecret === this.refreshSecret) {
      throw new Error(
        'JWT_ACCESS_SECRET 与 JWT_REFRESH_SECRET 不能相同，否则 access token 可当 refresh token 使用',
      );
    }
  }

  /**
   * 签发一对令牌，并把 refresh token 落库。
   *
   * @param replacedFromId 轮换场景传入被替换的旧令牌记录 ID，落库后会把它标记为已失效并指向新记录
   */
  async issueTokenPair(
    subject: TokenSubject,
    context: TokenContext = {},
    replacedFromId?: string,
  ): Promise<TokenPair> {
    const base = {
      sub: subject.id,
      username: subject.username,
      name: subject.name,
      roles: subject.roles,
      tokenVersion: subject.tokenVersion,
    };

    const accessToken = await this.jwt.signAsync(
      { ...base, type: 'access', jti: randomUUID() } satisfies JwtPayload,
      { secret: this.accessSecret, expiresIn: this.accessExpiresIn },
    );
    const refreshToken = await this.jwt.signAsync(
      { ...base, type: 'refresh', jti: randomUUID() } satisfies JwtPayload,
      { secret: this.refreshSecret, expiresIn: this.refreshExpiresIn },
    );

    const refreshTokenId = nextSnowflakeId();
    // 过期时间直接取令牌自带的 exp，避免再解析一遍 '7d' 这类时长字符串
    const refreshDecoded = this.jwt.decode<DecodedJwtPayload>(refreshToken);
    const expiresAt = new Date((refreshDecoded?.exp ?? 0) * 1000);

    await this.em.insert(RefreshTokenEntity, {
      id: refreshTokenId,
      userId: subject.id,
      tokenHash: hashToken(refreshToken),
      expiresAt,
      revoked: false,
      userAgent: context.userAgent?.slice(0, 500) ?? null,
      ip: context.ip?.slice(0, 64) ?? null,
    });

    if (replacedFromId) {
      await this.em.update(
        RefreshTokenEntity,
        { id: replacedFromId },
        { replacedById: refreshTokenId },
      );
    }

    const accessDecoded = this.jwt.decode<DecodedJwtPayload>(accessToken);

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: (accessDecoded?.exp ?? 0) - (accessDecoded?.iat ?? 0),
    };
  }

  /**
   * 校验 access token 并还原当前用户。
   *
   * 除了验签（签名错误 / 过期 / type 不符一律 401），还要拿用户**当前**状态比对一次：
   * access token 在过期前无法单独撤销，所以「禁用账号 / 强制下线 / 改密码 / 登出」
   * 都通过在 kh_user.token_version 上自增来即时生效。
   *
   * 代价是每个受保护请求多一次主键查询（约 0.1ms）。量级上来后可以在这一层加
   * 进程内短 TTL 缓存，届时失效会有秒级延迟，需按业务容忍度取舍。
   */
  async verifyAccessToken(token: string): Promise<AuthenticatedUser> {
    const payload = await this.verify(token, this.accessSecret, 'access');

    // 显式 select：只需要判断用的三列，避免把 password 哈希读进内存
    const state = await this.em.findOne(UserEntity, {
      where: { id: payload.sub },
      select: ['id', 'status', 'deleted', 'tokenVersion'],
    });

    if (!state || state.deleted || state.status !== UserStatus.Enabled) {
      throw new UnauthorizedException('账号不存在或已被禁用');
    }

    if (state.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException('登录状态已失效，请重新登录');
    }

    return {
      id: payload.sub,
      username: payload.username,
      name: payload.name,
      roles: payload.roles ?? [],
    };
  }

  /**
   * 消费一个 refresh token：验签、查库、判过期，并原子地将其置为已失效。
   *
   * 复用检测：拿一个**已被轮换掉**的令牌来刷新，说明令牌已泄漏，
   * 此时吊销该用户全部刷新令牌，宁可让用户重新登录。
   *
   * @returns 该令牌的归属用户 ID 与令牌记录 ID
   */
  async consumeRefreshToken(
    rawToken: string,
  ): Promise<{ userId: string; rowId: string }> {
    const payload = await this.verify(rawToken, this.refreshSecret, 'refresh');
    const row = await this.em.findOne(RefreshTokenEntity, {
      where: { tokenHash: hashToken(rawToken) },
    });

    if (!row) {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }

    if (row.revoked) {
      await this.revokeAllForUser(row.userId);
      throw new UnauthorizedException('刷新令牌已失效，请重新登录');
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }

    if (row.userId !== payload.sub) {
      // 哈希对得上但归属不符，理论上不可达；保守拒绝
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }

    // 条件更新：只有仍未被撤销时才置为已撤销，并发刷新时只有一个请求能成功
    const result = await this.em.update(
      RefreshTokenEntity,
      { id: row.id, revoked: false },
      { revoked: true, revokedAt: new Date() },
    );
    if (!result.affected) {
      await this.revokeAllForUser(row.userId);
      throw new UnauthorizedException('刷新令牌已失效，请重新登录');
    }

    return { userId: row.userId, rowId: row.id };
  }

  /**
   * 吊销刷新令牌，并让该用户已签发的 access token 立即失效。
   *
   * 幂等：令牌不存在也静默成功，避免被用来探测令牌是否有效。
   */
  async revokeRefreshToken(
    rawToken: string,
    allDevices = false,
  ): Promise<void> {
    const row = await this.em.findOne(RefreshTokenEntity, {
      where: { tokenHash: hashToken(rawToken) },
    });
    // 认不出令牌就认不出用户，无从吊销；静默返回
    if (!row) {
      return;
    }

    if (allDevices) {
      await this.revokeAllForUser(row.userId);
      return;
    }

    if (!row.revoked) {
      await this.em.update(
        RefreshTokenEntity,
        { id: row.id },
        { revoked: true, revokedAt: new Date() },
      );
    }

    // 单设备登出同样要自增版本号 —— 失效粒度是「该用户」而非「该设备」，
    // 因此登出设备自己的 access token 立即作废，其他设备会收到一次 401，
    // 靠 refresh 换新令牌后无感恢复（它们没被吊销刷新令牌）。
    await this.bumpTokenVersion(row.userId);
  }

  /** 吊销某用户全部未失效的刷新令牌，并使其已签发的 access token 立即失效 */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.em.update(
      RefreshTokenEntity,
      { userId, revoked: false },
      { revoked: true, revokedAt: new Date() },
    );
    await this.bumpTokenVersion(userId);
  }

  /**
   * 自增用户的令牌版本号，使其**全部**已签发的 access token 立即失效。
   *
   * 用途：登出、登出所有设备、强制下线、改密码、检出刷新令牌复用。
   * 也可直接改库：`UPDATE kh_user SET token_version = token_version + 1 WHERE id = ?`
   */
  async bumpTokenVersion(userId: string): Promise<void> {
    await this.em.increment(UserEntity, { id: userId }, 'tokenVersion', 1);
  }

  /** 验签 + 断言载荷 type；任何失败都归一成 401，不向外泄漏具体原因 */
  private async verify(
    token: string,
    secret: string,
    expectedType: JwtPayload['type'],
  ): Promise<JwtPayload> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token, { secret });
    } catch {
      throw new UnauthorizedException(
        expectedType === 'access' ? '访问令牌无效或已过期' : '刷新令牌无效或已过期',
      );
    }

    if (payload.type !== expectedType) {
      throw new UnauthorizedException(
        expectedType === 'access' ? '访问令牌无效或已过期' : '刷新令牌无效或已过期',
      );
    }

    return payload;
  }
}
