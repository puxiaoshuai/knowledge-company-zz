/**
 * 权限管理接口的对外文案。
 *
 * 与 UserMessage 同一思路：按模块隔离文案，改一句话时能立刻知道影响面；
 * guard 的 403 文案也放这里（「无权限执行该操作」），与 RolesGuard 硬编码的
 * 那句保持同字面量 —— 前端对 403 只有一个分支，两处文案分叉没有意义。
 *
 * 状态启用值不在这里重复定义：直接用实体上的 `PermissionStatus.Enabled`，
 * 避免同一事实两处落字面量。
 */
export const PermissionMessage = {
  /** 404：权限不存在，或已被软删除 */
  NotFound: '权限不存在',
  /** 400：指定的父权限不存在（或已软删） */
  ParentNotFound: '父权限不存在',
  /** 400：权限编码与现有（含软删）权限重复 */
  CodeAlreadyTaken: '权限编码已存在',
  /** 400：删除目标还存在未删除的子权限 */
  HasChildren: '存在子权限，请先删除或移走子权限',
  /** 400：把权限挂到了自己或自己的后代下面 */
  CycleDetected: '不能把权限挂到自己或其后代下面',
  /** 400：请求里的权限 ID 在 kh_permission 里不存在、已禁用或已软删 */
  NotAvailable: '权限不存在或已被禁用',
  /** 404：目标角色不存在 */
  RoleNotFound: '角色不存在',
  /** 400：给已禁用的角色分配权限 */
  RoleDisabled: '角色已被禁用，不能分配权限',
  /** 404：目标用户不存在，或已被软删除 */
  UserNotFound: '用户不存在',
  /** 403：缺少 @RequirePermissions 要求的权限码 */
  Forbidden: '无权限执行该操作',
} as const;
