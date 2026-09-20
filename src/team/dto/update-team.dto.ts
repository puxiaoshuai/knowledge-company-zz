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
 * 修改团队（仅管理员）。所有字段可选，只改传了的。
 *
 * ## 刻意不声明的字段
 *
 * - `id`：主键，改了会让 kh_team_member / kh_document.team_id 的引用集体悬空。
 * - `createdAt` / `updatedAt` / `deleted`：内部字段。
 *
 * 传了未声明字段会被全局 ValidationPipe 的 forbidNonWhitelisted 判 400
 * （与 user / permission 模块同一防越权字段机制）。
 */
export class UpdateTeamDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: '团队名称不能为空' })
  @MaxLength(100, { message: '团队名称长度最多 100 位' })
  teamName?: string;

  /** 团队编码。改成与现有（未删除）团队重复的值会被拒绝 */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{2,50}$/, {
    message: '团队编码只能包含字母、数字、下划线、连字符，长度 2-50',
  })
  teamCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: '描述长度最多 500 位' })
  description?: string;

  /** 负责人 ID（须为存在、启用且未删除的用户） */
  @IsOptional()
  @IsString()
  leaderId?: string;

  /** 父团队 ID。不能指向自己或自己的后代（服务端沿 parent 链上溯检测） */
  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort?: number;

  @IsOptional()
  @Type(() => Number)
  @IsIn([TeamStatus.Disabled, TeamStatus.Enabled], {
    message: '状态只能是 0（禁用）或 1（启用）',
  })
  status?: TeamStatus;
}
