import type { RoleCode } from '../constants/role.constant.js';

/**
 * JWT 载荷：access / refresh 共用同一结构，靠 type 区分用途。
 * 两个令牌用不同 secret 签发，type 声明是第二道保险。
 */
export interface JwtPayload {
  /** 用户 ID（雪花，字符串；务必不要 Number() 转换） */
  sub: string;
  /** 登录用户名 */
  username: string;
  /** 展示名：realName 优先，回退 username */
  name: string;
  /** 角色编码列表 */
  roles: RoleCode[];
  /**
   * 签发时 kh_user.token_version 的快照。
   *
   * access token 无法单独撤销，靠它做整体失效：库里的值一旦自增，
   * 所有带着旧快照的令牌在下次请求时都会被判为失效。
   */
  tokenVersion: number;
  /** 令牌用途，防止 refresh 当 access 用（反之亦然） */
  type: 'access' | 'refresh';
  /** 令牌唯一 ID，便于日志追溯 */
  jti: string;
}

/** 已解码的 JWT 载荷附带标准时间声明，用于推算有效期 */
export interface DecodedJwtPayload extends JwtPayload {
  /** 签发时间（Unix 秒） */
  iat?: number;
  /** 过期时间（Unix 秒） */
  exp?: number;
}
