/** 角色编码，与 kh_role.role_code 一一对应（见 init-scripts/postgresql/init.sql 预置数据） */
export const RoleCode = {
  /** 管理员：系统管理 */
  Admin: 'ROLE_ADMIN',
  /** 审核员：文档审核 */
  Reviewer: 'ROLE_REVIEWER',
  /** 普通用户：注册时默认授予 */
  User: 'ROLE_USER',
} as const;

export type RoleCode = (typeof RoleCode)[keyof typeof RoleCode];
