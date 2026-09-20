import type { RoleCode } from '../constants/role.constant.js';

/** 鉴权通过后挂到 request.user 的当前用户（由 JwtAuthGuard 写入） */
export interface AuthenticatedUser {
  /** 用户 ID（雪花，字符串） */
  id: string;
  /** 登录用户名 */
  username: string;
  /** 展示名 */
  name: string;
  /** 角色编码列表，来自 JWT 载荷 */
  roles: RoleCode[];
}
