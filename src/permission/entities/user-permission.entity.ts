import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bitint.transformer.js';

/** 用户直授权限关联（PostgreSQL kh_user_permission） */
@Entity('kh_user_permission')
export class UserPermissionEntity {
  /** 关联 ID（雪花） */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 用户 ID */
  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer })
  userId: string;

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
