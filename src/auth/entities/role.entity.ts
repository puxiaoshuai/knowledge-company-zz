import { Column, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bitint.transformer.js';

/** 角色（PostgreSQL kh_role） */
@Entity('kh_role')
export class RoleEntity {
  /** 角色 ID（雪花） */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 角色名称（展示用） */
  @Column({ name: 'role_name', type: 'varchar', length: 50 })
  roleName: string;

  /** 角色编码，如 ROLE_ADMIN / ROLE_REVIEWER / ROLE_USER */
  @Column({ name: 'role_code', type: 'varchar', length: 50, unique: true })
  roleCode: string;

  /** 角色描述 */
  @Column({ type: 'varchar', length: 200, nullable: true })
  description?: string | null;

  /** 0 禁用 1 启用 */
  @Column({ type: 'smallint', default: 1 })
  status: number;
}
