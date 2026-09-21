import { Module } from '@nestjs/common';
import { PipelineModule } from '../pipeline/pipeline.module.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

/**
 * 搜索模块：文档关键词检索。
 *
 * imports PipelineModule 取其导出的 SearchIndexService（ES kh_document 索引），
 * 本模块自身不持有 ES 连接。
 */
@Module({
  imports: [PipelineModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
