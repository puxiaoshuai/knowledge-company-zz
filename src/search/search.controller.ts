import { Controller, Get, Query } from '@nestjs/common';
import { SearchService } from './search.service.js';
import { SearchDocumentDto } from './dto/search-document.dto.js';

/**
 * 文档搜索接口。
 *
 * 需登录（全局 JwtAuthGuard 默认拒绝），不设额外角色门；
 * categoryId / authorId 原样透传 ES 做 term 过滤。
 */
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  /** 关键词检索文档：命中字段以 <em> 高亮返回 */
  @Get('documents')
  searchDocuments(@Query() dto: SearchDocumentDto) {
    return this.searchService.searchDocuments(dto);
  }
}
