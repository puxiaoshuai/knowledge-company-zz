import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bitint.transformer.js';

/**
 * 权限类型：1 菜单 2 按钮 3 接口。
 *
 * 菜单型节点供前端动态菜单（/permissions/me 的 menus 树），
 * 按钮型供前端 v-permission 显隐（codes 集合），
 * 接口型目前只是元数据 —— 运行时校验只看 permission_code，不按 api_url 匹配。
 */
export const PermissionType = {
  Menu: 1,
  Button: 2,
  Api: 3,
} as const;

export type PermissionType =
  (typeof PermissionType)[keyof typeof PermissionType];

/** 权限状态：0 禁用 1 启用 */
export const PermissionStatus = {
  Disabled: 0,
  Enabled: 1,
} as const;

export type PermissionStatus =
  (typeof PermissionStatus)[keyof typeof PermissionStatus];

/** 权限（PostgreSQL kh_permission） */
@Entity('kh_permission')
export class PermissionEntity {
  /** 权限 ID（雪花） */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 父权限 ID，'0' 为根（树形结构） */
  @Column({ name: 'parent_id', type: 'bigint', transformer: bigintTransformer })
  parentId: string;

  /** 权限名称（展示用） */
  @Column({ name: 'permission_name', type: 'varchar', length: 50 })
  permissionName: string;

  /** 权限编码，运行时校验的唯一依据（如 document:edit） */
  @Column({
    name: 'permission_code',
    type: 'varchar',
    length: 100,
    unique: true,
  })
  permissionCode: string;

  /** 权限类型：1 菜单 2 按钮 3 接口 */
  @Column({ name: 'permission_type', type: 'smallint' })
  permissionType: PermissionType;

  /** 菜单路径（菜单型权限用） */
  @Column({ name: 'menu_url', type: 'varchar', length: 200, nullable: true })
  menuUrl?: string | null;

  /** 接口 URL 模式（接口型权限的元数据，暂不参与运行时校验） */
  @Column({ name: 'api_url', type: 'varchar', length: 500, nullable: true })
  apiUrl?: string | null;

  /** HTTP 方法（接口型权限的元数据） */
  @Column({ type: 'varchar', length: 10, nullable: true })
  method?: string | null;

  /** 图标（菜单型权限用） */
  @Column({ type: 'varchar', length: 50, nullable: true })
  icon?: string | null;

  /** 排序值，同级升序 */
  @Column({ type: 'int', default: 0 })
  sort: number;

  /** 0 禁用 1 启用 */
  @Column({ type: 'smallint', default: PermissionStatus.Enabled })
  status: PermissionStatus;

  /** 创建时间 */
  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  /** 更新时间 */
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt: Date;

  /** 逻辑删除 */
  @Column({ type: 'boolean', default: false })
  deleted: boolean;
}
