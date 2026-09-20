/** 元数据键：标记路由无需登录（见 @Public()） */
export const IS_PUBLIC_KEY = 'auth:isPublic';

/** 元数据键：标记路由所需角色（见 @Roles()） */
export const ROLES_KEY = 'auth:roles';

/** bcrypt 代价因子，与 init.sql 里测试账号的哈希保持一致 */
export const BCRYPT_ROUNDS = 10;
