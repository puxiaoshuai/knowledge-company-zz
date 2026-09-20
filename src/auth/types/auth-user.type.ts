import type { RoleCode } from '../constants/role.constant.js';
import type { TokenPair } from './token-context.type.js';

/**
 * 对外暴露的用户信息。
 *
 * 显式声明字段而**不是**直接返回 UserEntity —— 那样会把 password 一起序列化出去。
 */
export interface AuthUser {
  /** 用户 ID（雪花，字符串） */
  id: string;
  /** 登录用户名 */
  username: string;
  /** 邮箱 */
  email: string | null;
  /** 真实姓名 / 显示名 */
  realName: string | null;
  /** 头像 URL */
  avatar: string | null;
  /** 角色编码列表 */
  roles: RoleCode[];
  /** 最后登录时间 */
  lastLoginAt: Date | null;
  /** 创建时间 */
  createdAt: Date;
}

/** 登录 / 注册 / 刷新的返回结构 */
export interface AuthResult extends TokenPair {
  /** 当前登录用户 */
  user: AuthUser;
}
