import { PartialType, OmitType } from '@nestjs/mapped-types';
import { IsOptional, IsString } from 'class-validator';
import { CreateDocumentDto } from './create-document.dto.js';

/** 更新文档（字段均可选） */
export class UpdateDocumentDto extends PartialType(
  OmitType(CreateDocumentDto, ['createBy'] as const),
) {
  /** @deprecated 更新人已改从 JWT 取当前用户，每次更新都会写入 */
  @IsOptional()
  @IsString()
  updateBy?: string;
}
