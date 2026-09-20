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
  /**
   * 邮箱是否已验证。
   *
   * 对外暴露成 boolean 而不是库里的 0/1：前端不该去猜这个映射
   * （status 没暴露正是为了避免同类歧义），布尔在 JSON 里自解释。
   */
  emailVerified: boolean;
  /** 最后登录时间 */
  lastLoginAt: Date | null;
  /** 创建时间 */
  createdAt: Date;
}

/** 登录 / 刷新的返回结构 */
export interface AuthResult extends TokenPair {
  /** 当前登录用户 */
  user: AuthUser;
}

/**
 * 注册返回结构。
 *
 * 注意这里**不含令牌**：注册只是受理，必须点完邮箱里的激活链接才能登录
 * （见 AuthService.register）。所以它不是 AuthResult。
 */
export interface RegisterResult {
  success: true;
  /** 用户 ID（雪花，字符串） */
  id: string;
  /** 登录用户名 */
  username: string;
  /** 邮箱（已归一为小写） */
  email: string;
  message: string;
}

/** 邮箱激活结果 */
export interface VerifyEmailResult {
  success: true;
  username: string;
  email: string | null;
  /**
   * 本次调用是否属于「重复点击」。
   *
   * 激活接口是幂等的：邮件客户端预取链接、用户双击都会打到同一个 token，
   * 此时不写库、只回 alreadyVerified=true，而不是把用户挡在「链接已失效」外面。
   */
  alreadyVerified: boolean;
  message: string;
}

/** 重发激活邮件结果。响应内容恒定，不反映账号是否存在 / 是否已激活 */
export interface ResendVerificationResult {
  success: true;
  message: string;
}
