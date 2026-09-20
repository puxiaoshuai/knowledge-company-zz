import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bitint.transformer.js';

/** 角色权限关联（PostgreSQL kh_role_permission） */
@Entity('kh_role_permission')
export class RolePermissionEntity {
  /** 关联 ID（雪花） */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 角色 ID */
  @Column({ name: 'role_id', type: 'bigint', transformer: bigintTransformer })
  roleId: string;

  /** 权限 ID */
  @Column({
    name: 'permission_id',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  permissionId: string;

  /** 分配时间 */
  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;
}
