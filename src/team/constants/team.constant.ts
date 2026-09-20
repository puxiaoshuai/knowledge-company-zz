/**
 * 团队管理接口的对外文案。
 *
 * 与 UserMessage / PermissionMessage 同一思路：按模块隔离，
 * 改一句话时能立刻知道影响面，也便于与接口文档的消息表一一对应。
 */
export const TeamMessage = {
  /** 404：团队不存在，或已被软删除 */
  NotFound: '团队不存在',
  /** 400：指定的父团队不存在（或已软删） */
  ParentNotFound: '父团队不存在',
  /** 400：把团队挂到了自己或自己的后代下面 */
  CycleDetected: '不能把团队挂到自己或其后代下面',
  /** 400：删除目标还存在未删除的子团队 */
  HasChildren: '存在子团队，请先删除或移走子团队',
  /** 400：团队编码与现有（未删除）团队重复 */
  CodeAlreadyTaken: '团队编码已存在',
  /** 400：负责人不存在、已软删或已禁用 */
  LeaderNotAvailable: '负责人不存在或已被禁用',
  /** 400：成员列表里的负责人标注与团队负责人字段不一致 */
  LeaderConflict: '成员中的负责人与团队负责人不一致，请先修改团队负责人',
  /** 400：成员列表里出现了多个负责人标注 */
  MultipleLeaders: '团队成员中只能有一名负责人',
  /** 400：成员用户不存在、已软删或已禁用 */
  MemberUserNotAvailable: '成员用户不存在或已被禁用',
  /** 400：成员列表里有重复用户 */
  DuplicateMember: '团队成员不能重复',
} as const;
