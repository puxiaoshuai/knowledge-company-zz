import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** 审核任务列表查询（审核员工作台） */
export class QueryReviewTasksDto {
  /** 筛选：pending 待办 | approved 已通过 | rejected 已驳回；默认 pending */
  @IsOptional()
  @IsString()
  status?: 'pending' | 'approved' | 'rejected';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

/**
 * 审核通过 / 驳回请求体
 *
 * 审核人身份已改从 JWT 取，这两个字段不再生效。
 */
export class ReviewDecisionDto {
  /** 审核意见（驳回时必填） */
  @IsOptional()
  @IsString()
  reviewComment?: string;

  /**
   * @deprecated 已改从 JWT 取当前用户，此字段不再生效。
   * 保留仅为兼容老前端 —— 全局 ValidationPipe 开了 forbidNonWhitelisted，删掉会让旧请求直接 400。
   */
  @IsOptional()
  @IsString()
  reviewerId?: string;

  /** @deprecated 同上，已改从 JWT 取当前用户 */
  @IsOptional()
  @IsString()
  reviewerName?: string;
}
