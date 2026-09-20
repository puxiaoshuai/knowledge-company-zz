import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bitint.transformer.js';

/** 用户角色关联（PostgreSQL kh_user_role） */
@Entity('kh_user_role')
export class UserRoleEntity {
  /** 关联 ID（雪花） */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 用户 ID */
  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer })
  userId: string;

  /** 角色 ID */
  @Column({ name: 'role_id', type: 'bigint', transformer: bigintTransformer })
  roleId: string;

  /** 分配时间 */
  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;
}
