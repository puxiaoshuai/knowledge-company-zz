import { Type } from 'class-transformer';
import { IsArray, IsIn, IsString, ValidateNested } from 'class-validator';
import { TeamMemberRole } from '../entities/team-member.entity.js';

/** 单个成员条目 */
export class TeamMemberItemDto {
  /** 用户 ID（雪花，字符串） */
  @IsString()
  userId: string;

  /** 成员角色：leader 负责人 / member 普通成员 */
  @IsIn([TeamMemberRole.Leader, TeamMemberRole.Member], {
    message: '成员角色只能是 leader 或 member',
  })
  memberRole: TeamMemberRole;
}

/**
 * 整体替换团队成员（PUT /teams/:id/members）。
 *
 * 传的是**全集**：不在列表里的现有成员一并移出。空数组 = 清空成员
 * （团队保留、人全部退出，是合法的管理动作）。
 *
 * 与 kh_team.leader_id 的一致性规则（服务端强制）：
 * - members 里 leader 标注最多 1 个；
 * - 团队已有 leader_id 且与成员里的 leader 不是同一人 → 400（先 PATCH 改负责人）；
 * - 团队 leader_id 为空且成员里有 leader → 同事务补写 leader_id；
 * - 成员里没有 leader → 不动 leader_id（负责人可以不挂在成员表里）。
 */
export class AssignTeamMembersDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TeamMemberItemDto)
  members: TeamMemberItemDto[];
}
