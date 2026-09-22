import { Body, Controller, Post } from '@nestjs/common';
import { AiChatService } from './ai-chat.service';
import { HybridRetrievalService } from './hybrid-retrieval.service';
import { ChatDto } from './dto/chat.dto';
import { RagSearchDto } from './dto/rag-search.dto';
import { PermissionCode } from '../auth/constants/auth.constant.js';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator.js';

/** RAG 接口：检索走 search 权限码，对话走 chat 权限码 */
@Controller()
export class AiController {
  constructor(
    private readonly aiChat: AiChatService,
    private readonly retrieval: HybridRetrievalService,
  ) {}

  /**
   * RAG 混合检索：关键词 BM25 + 向量 kNN → RRF → rerank。
   * 不调用 LLM，只返回 kh_chunk 命中。
   */
  @Post('rag/search')
  @RequirePermissions(PermissionCode.Search)
  search(@Body() dto: RagSearchDto) {
    return this.retrieval.retrieve(dto.query.trim(), dto.topK ?? 5);
  }

  /** RAG 对话：混合检索后再作答 */
  @Post('ai/chat')
  @RequirePermissions(PermissionCode.Search)
  chat(@Body() dto: ChatDto) {
    return this.aiChat.chat(dto.content, dto.topK ?? 5);
  }
}
