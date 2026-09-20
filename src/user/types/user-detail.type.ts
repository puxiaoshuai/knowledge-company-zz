import type { AuthUser } from '../../auth/types/auth-user.type.js';

/**
 * 管理端看到的用户详情。
 *
 * 在 AuthUser 之上叠加两个字段，而不是另起一套：
 *
 * - `status`：AuthUser **刻意不暴露它**（0/1 会让前端去猜映射，而 emailVerified
 *   已经用布尔自解释地表达了同类概念）。但管理端的核心操作就是「启用 / 禁用」，
 *   一次列表里看不到状态等于什么都做不了，所以在这里补回来。
 *   代价是管理端的映射不能直接用 toAuthUser，得在其返回值上补字段。
 * - `updatedAt`：AuthUser 只有 createdAt。改完用户后前端要能看出「这次改动生效了」。
 *
 * 注意 `password` 依旧不在这里 —— 它由 toAuthUser 的显式挑字段挡住。
 */
export interface UserDetail extends AuthUser {
  /** 0 禁用 1 启用 */
  status: number;
  /** 更新时间 */
  updatedAt: Date;
}

/** 用户分页列表，与文档列表同一个形状（接口文档 §1.3） */
export interface UserListResult {
  items: UserDetail[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 软删除结果，与文档模块的软删返回保持一致。
 *
 * 返回 `deleted: true` 而不是空 204：前端可以直接用它更新本地那条记录，
 * 不必自己假设「调了就一定成功」。
 */
export interface DeleteUserResult {
  id: string;
  deleted: true;
}
