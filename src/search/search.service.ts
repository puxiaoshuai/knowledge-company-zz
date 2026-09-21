import { Injectable } from '@nestjs/common';
import {
  SearchIndexService,
  type SearchParams,
  type SearchResult,
} from '../pipeline/search-index.service.js';

/**
 * 文档搜索：薄门面，检索语义与高亮规则都在 SearchIndexService。
 *
 * 单独包一层的意义：后续在这加搜索结果补全（作者名/分类名）、
 * 权限过滤等业务逻辑时不用改 controller。
 */
@Injectable()
export class SearchService {
  constructor(private readonly searchIndex: SearchIndexService) {}


  searchDocuments(params: SearchParams): Promise<SearchResult> {
    return this.searchIndex.searchDocuments(params);
  }
}
