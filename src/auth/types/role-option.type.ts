import type { RoleCode } from '../constants/role.constant.js';

/**
 * 可分配的角色选项（`GET /users/roles` 用）。
 *
 * 单独做一个类型而不是直接返回 `RoleEntity`：实体的 `status` 是给内部谓词用的，
 * 而这里的语义是「一个可以被指派给用户的角色」，字段集合本身就不同。
 */
export interface RoleOption {
  /** 角色 ID（雪花，字符串） */
  id: string;
  /** 角色编码，分配角色时传这个值 */
  roleCode: RoleCode;
  /** 角色名称（展示用） */
  roleName: string;
  /** 角色描述 */
  description: string | null;
}
