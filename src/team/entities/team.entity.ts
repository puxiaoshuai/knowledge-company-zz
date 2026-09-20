import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bitint.transformer.js';

/** 团队状态：0 禁用 1 启用 */
export const TeamStatus = {
  Disabled: 0,
  Enabled: 1,
} as const;

export type TeamStatus = (typeof TeamStatus)[keyof typeof TeamStatus];

/** 团队（PostgreSQL kh_team） */
@Entity('kh_team')
export class TeamEntity {
  /** 团队 ID（雪花） */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 团队名称 */
  @Column({ name: 'team_name', type: 'varchar', length: 100 })
  teamName: string;

  /** 团队编码（应用层查重，库上无唯一约束） */
  @Column({ name: 'team_code', type: 'varchar', length: 50, nullable: true })
  teamCode?: string | null;

  /** 描述 */
  @Column({ type: 'varchar', length: 500, nullable: true })
  description?: string | null;

  /** 负责人 ID → kh_user.id。是权威字段，与成员表 member_role 不强制同步 */
  @Column({
    name: 'leader_id',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
  })
  leaderId?: string | null;

  /** 父团队 ID，'0' 为根（树形结构） */
  @Column({ name: 'parent_id', type: 'bigint', transformer: bigintTransformer })
  parentId: string;

  /** 排序值，同级升序 */
  @Column({ type: 'int', default: 0 })
  sort: number;

  /** 0 禁用 1 启用 */
  @Column({ type: 'smallint', default: TeamStatus.Enabled })
  status: TeamStatus;

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
