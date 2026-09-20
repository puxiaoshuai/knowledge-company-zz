import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { DocumentStatus } from '../document-status';

/** 创建文档（status 见 DocumentStatus，开启审核时不允许直接 Published） */
export class CreateDocumentDto {
  /** 标题 */
  @IsString()
  title: string;

  /** Markdown 正文 */
  @IsString()
  content: string;

  /** 摘要 */
  @IsOptional()
  @IsString()
  summary?: string;

  /** 分类 ID */
  @IsOptional()
  @IsString()
  categoryId?: string;

  /** 团队 ID */
  @IsOptional()
  @IsString()
  teamId?: string;

  /**
   * @deprecated 已改从 JWT 取当前用户，此字段不再生效。
   * 保留仅为兼容老前端 —— 全局 ValidationPipe 开了 forbidNonWhitelisted，删掉会让旧请求直接 400。
   */
  @IsOptional()
  @IsString()
  authorId?: string;

  /** 封面图 URL */
  @IsOptional()
  @IsString()
  coverImage?: string;

  /** 标签（逗号分隔） */
  @IsOptional()
  @IsString()
  tags?: string;

  /** 状态 */
  @IsOptional()
  @IsEnum(DocumentStatus)
  status?: DocumentStatus;

  /** 备注 */
  @IsOptional()
  @IsString()
  remark?: string;

  /** 是否公开 */
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  /** @deprecated 同上，作者 / 创建人已改从 JWT 取当前用户 */
  @IsOptional()
  @IsString()
  createBy?: string;
}
