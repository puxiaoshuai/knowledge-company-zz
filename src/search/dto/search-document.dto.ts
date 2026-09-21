import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** 文档关键词检索查询 */
export class SearchDocumentDto {
  /** 关键词，匹配标题/摘要/正文；为空则只按过滤条件分页 */
  @IsOptional()
  @IsString()
  keyword?: string;

  /** 分类 ID */
  @IsOptional()
  @IsString()
  categoryId?: string;

  /** 作者 ID */
  @IsOptional()
  @IsString()
  authorId?: string;

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
  pageSize?: number = 10;
}
