import type { RoleCode } from '../constants/role.constant.js';

/** 签发令牌时记录的设备信息，仅用于会话审计 */
export interface TokenContext {
  /** 客户端 UA */
  userAgent?: string | null;
  /** 客户端 IP */
  ip?: string | null;
}

/** 一对令牌。expiresIn 为 access token 剩余有效期（秒） */
export interface TokenPair {
  /** 访问令牌，放在 Authorization: Bearer <accessToken> */
  accessToken: string;
  /** 刷新令牌，仅用于 POST /auth/refresh */
  refreshToken: string;
  /** 固定为 Bearer */
  tokenType: 'Bearer';
  /** access token 有效期（秒） */
  expiresIn: number;
}

/** 令牌所属用户，签发时写入 JWT 载荷 */
export interface TokenSubject {
  /** 用户 ID（雪花，字符串） */
  id: string;
  /** 登录用户名 */
  username: string;
  /** 展示名 */
  name: string;
  /** 角色编码列表 */
  roles: RoleCode[];
  /** 签发时的令牌版本号，取自 kh_user.token_version */
  tokenVersion: number;
}
