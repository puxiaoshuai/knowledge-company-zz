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

/**
 * `kh_role.status` 的「启用」取值。
 *
 * 提成常量是因为同一个谓词现在出现在两处：授权侧（加载用户角色时过滤掉被禁用的角色）
 * 与角色解析侧（管理员分配角色时拒绝已禁用的编码）。两处各写一个裸 1 的话，
 * 日后一旦要支持别的状态值就会只改一处。
 */
export const ROLE_STATUS_ENABLED = 1;
