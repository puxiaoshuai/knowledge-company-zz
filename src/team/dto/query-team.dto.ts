import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { TeamStatus } from '../entities/team.entity.js';

/** 团队列表查询（仅管理员） */
export class QueryTeamDto {
  /** 团队名称（模糊，ILIKE 不区分大小写） */
  @IsOptional()
  @IsString()
  teamName?: string;

  /** 团队编码（模糊，ILIKE 不区分大小写） */
  @IsOptional()
  @IsString()
  teamCode?: string;

  /** 状态：0 禁用 1 启用 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([TeamStatus.Disabled, TeamStatus.Enabled], {
    message: '状态只能是 0（禁用）或 1（启用）',
  })
  status?: TeamStatus;

  /** 页码，从 1 开始 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  /** 每页条数 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}
