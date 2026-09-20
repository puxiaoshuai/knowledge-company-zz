import type {
  PermissionStatus,
  PermissionType,
} from '../entities/permission.entity.js';

/**
 * 权限管理端的平铺视图（分页列表项）。
 *
 * 不返回实体而返回显式 interface，与 user 模块同一约定：
 * 出参形状是 REST 契约，不该被实体列的增减顺带改掉。
 */
export interface PermissionDetail {
  id: string;
  parentId: string;
  permissionName: string;
  permissionCode: string;
  permissionType: PermissionType;
  menuUrl: string | null;
  apiUrl: string | null;
  method: string | null;
  icon: string | null;
  sort: number;
  status: PermissionStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** 管理端权限树节点（含禁用节点，勾选树用；不含时间戳） */
export interface PermissionTreeNode {
  id: string;
  parentId: string;
  permissionName: string;
  permissionCode: string;
  permissionType: PermissionType;
  menuUrl: string | null;
  apiUrl: string | null;
  method: string | null;
  icon: string | null;
  sort: number;
  status: PermissionStatus;
  children: PermissionTreeNode[];
}

/** /permissions/me 的菜单节点（仅启用的菜单型权限，前端动态路由用） */
export interface MenuTreeNode {
  id: string;
  permissionCode: string;
  permissionName: string;
  menuUrl: string | null;
  icon: string | null;
  sort: number;
  children: MenuTreeNode[];
}

/** GET /permissions/me 的响应：codes 给按钮显隐，menus 给动态菜单 */
export interface MyPermissionsResult {
  codes: string[];
  menus: MenuTreeNode[];
}

/** 分页结果（与 user 模块同形状） */
export interface PermissionListResult {
  items: PermissionDetail[];
  total: number;
  page: number;
  pageSize: number;
}

/** 删除结果 */
export interface DeletePermissionResult {
  id: string;
  deleted: true;
}

/** 角色 / 用户已分配的权限 id 列表（授权回显用） */
export interface AssignedPermissionIds {
  ownerId: string;
  permissionIds: string[];
}
