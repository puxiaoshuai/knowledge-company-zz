/**
 * 用户管理接口的对外文案。
 *
 * 与 AuthMessage 分开，而不是塞进同一个对象：那些是**匿名可访问**的鉴权链路文案，
 * 这些全部只在管理员后台出现。受众不同、前端的分支方式也不同，
 * 混在一起会让「改一句话要确认有没有影响公开接口」变成每次都要做的功课。
 *
 * 两条链路真正共用的三句（`用户名已存在` / `邮箱已被注册`）**不在这里复制**，
 * 而是由 user-identity.util.ts 的 rethrowUserUniqueViolation 统一抛 AuthMessage ——
 * 同一句话只允许有一个字面量。
 */
export const UserMessage = {
  /** 404：用户不存在，或已被软删除 */
  NotFound: '用户不存在',
  /** 400：请求里的角色编码在 kh_role 里不存在，或已被禁用 */
  RoleNotAvailable: '角色不存在或已被禁用',
  /** 400：删除的目标是当前登录账号 */
  CannotDeleteSelf: '不能删除当前登录账号',
  /** 400：禁用的目标是当前登录账号 */
  CannotDisableSelf: '不能禁用当前登录账号',
  /** 400：把当前登录账号的邮箱置为未验证 */
  CannotUnverifySelf: '不能把当前登录账号置为邮箱未验证',
  /** 400：删除后系统将不再有任何启用中的管理员 */
  CannotDeleteLastAdmin: '不能删除最后一个启用中的管理员',
  /** 400：禁用后系统将不再有任何启用中的管理员 */
  CannotDisableLastAdmin: '不能禁用最后一个启用中的管理员',
  /** 400：摘掉该角色后系统将不再有任何启用中的管理员 */
  CannotRemoveLastAdminRole: '不能移除最后一个启用中的管理员角色',
} as const;
