import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { TeamStatus } from '../entities/team.entity.js';

/**
 * 新增团队（仅管理员）。
 *
 * leaderId 只是指针，**不会**自动写一条 kh_team_member 的 leader 行 ——
 * 成员归属由 PUT /teams/:id/members 整体管理，两件事刻意不耦合
 * （否则「改个负责人」会顺带改成员表，PUT members 又会反写 leader_id，
 * 两个入口互相踩脚）。
 */
export class CreateTeamDto {
  /** 团队名称 */
  @IsString()
  @MinLength(1, { message: '团队名称不能为空' })
  @MaxLength(100, { message: '团队名称长度最多 100 位' })
  teamName: string;

  /**
   * 团队编码（如 TECH_CENTER）。库上无唯一约束，靠服务层查重
   * （并发窗口已记录为已知缺口）。
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{2,50}$/, {
    message: '团队编码只能包含字母、数字、下划线、连字符，长度 2-50',
  })
  teamCode?: string;

  /** 描述 */
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: '描述长度最多 500 位' })
  description?: string;

  /** 负责人 ID（须为存在、启用且未删除的用户） */
  @IsOptional()
  @IsString()
  leaderId?: string;

  /** 父团队 ID，缺省 '0'（根）。保持字符串：雪花 id 超出 JS 安全整数 */
  @IsOptional()
  @IsString()
  parentId?: string;

  /** 排序值，同级升序 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort?: number;

  /** 初始状态，默认启用 */
  @IsOptional()
  @Type(() => Number)
  @IsIn([TeamStatus.Disabled, TeamStatus.Enabled], {
    message: '状态只能是 0（禁用）或 1（启用）',
  })
  status?: TeamStatus;
}
