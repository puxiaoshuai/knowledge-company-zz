import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bitint.transformer.js';

/** 成员在团队内的角色标注：leader 负责人 / member 普通成员 */
export const TeamMemberRole = {
  Leader: 'leader',
  Member: 'member',
} as const;

export type TeamMemberRole =
  (typeof TeamMemberRole)[keyof typeof TeamMemberRole];

/** 团队成员关联（PostgreSQL kh_team_member） */
@Entity('kh_team_member')
export class TeamMemberEntity {
  /** 关联 ID（雪花） */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 团队 ID */
  @Column({ name: 'team_id', type: 'bigint', transformer: bigintTransformer })
  teamId: string;

  /** 用户 ID */
  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer })
  userId: string;

  /** 成员角色：leader / member */
  @Column({
    name: 'member_role',
    type: 'varchar',
    length: 20,
    default: TeamMemberRole.Member,
  })
  memberRole: TeamMemberRole;

  /** 加入时间 */
  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;
}
