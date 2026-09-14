import { Injectable, Logger } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EntityManager } from 'typeorm';
import { DocumentEntity } from '../document/entities/document.entity';
import {
  DocumentContent,
  DocumentContentDocument,
} from '../document/schemas/document-content.schema';
import { ChunkingService } from './chunking.service';
import { EmbeddingService } from './embedding.service';
import { VectorIndexService } from './vector-index.service';
import { PipelineDocument } from './types/pipeline.types';

/**
 * 发布后知识管线编排器
 *
 * <p>RAG：分块 → Embedding → ES kh_chunk</p>
 *
 * <p>由 {@link DocumentPipelineConsumer} 在消费到 MQ 消息后调用；</p>
 * <p>本类负责「加载文档 → 调具体服务」，不直接碰 RabbitMQ。</p>
 */
@Injectable()
export class PipelineOrchestrator {
  private readonly logger = new Logger(PipelineOrchestrator.name);

  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
    @InjectModel(DocumentContent.name)
    private readonly contentModel: Model<DocumentContentDocument>,
    private readonly chunkingService: ChunkingService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorIndexService: VectorIndexService,
  ) {}

  /**
   * 处理 RAG 重建消息。
   *
   * 重建流水线（单文档）：清旧块 → Chunking → Embedding → 写入 ES kh_chunk
   *
   * @param traceId 发布入口生成的链路追踪 ID，透传到每条步骤日志
   */
  async handleRagReindex(
    type: string,
    documentIds: string[] | undefined,
    traceId: string,
  ) {
    if (type !== 'BY_DOC_IDS' || !documentIds?.length) {
      this.logger.warn(
        `[RAG] step=1/5 traceId=${traceId} 忽略未支持的消息 type=${type}`,
      );
      return;
    }

    const docs = await this.loadDocumentsByIds(documentIds);
    const startedAt = Date.now();
    this.logger.log(
      `[RAG] traceId=${traceId} 已加载文档 total=${docs.length} ` +
        `documentIds=${JSON.stringify(documentIds)}`,
    );

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      try {
        await this.reindexOne(doc, traceId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `[RAG] 失败 traceId=${traceId} docId=${doc.id} ` +
            `elapsed=${Date.now() - startedAt}ms error=${message}`,
        );
      }
    }

    // 单文档时 reindexOne 已打过逐篇汇总，这里只在多文档时补一条总量概览
    if (docs.length !== 1) {
      this.logger.log(
        `[RAG] 完成 traceId=${traceId} total=${docs.length} ` +
          `总耗时=${Date.now() - startedAt}ms`,
      );
    }
  }

  /** 单篇：清旧块 → 分块 → 批量嵌入 → 落库，逐步计时 */
  private async reindexOne(doc: PipelineDocument, traceId: string) {
    const t0 = Date.now();
    const log = (step: string, detail: string) =>
      this.logger.log(
        `[RAG] step=${step} traceId=${traceId} docId=${doc.id} ${detail}`,
      );

    if (!doc.content?.trim()) {
      this.logger.warn(
        `[RAG] step=2/5 traceId=${traceId} docId=${doc.id} ` +
          `正文为空，跳过索引（旧块保留）`,
      );
      return;
    }

    // ① 先清旧块，避免重复发布时脏数据残留
    await this.vectorIndexService.deleteByDocId(doc.id);
    log('2/5', `清旧块完成 elapsed=${Date.now() - t0}ms`);

    // ② 分块
    const tChunk = Date.now();
    const chunks = await this.chunkingService.chunk({
      content: doc.content,
      documentId: doc.id,
      documentTitle: doc.title,
      categoryId: doc.categoryId,
      authorId: doc.authorId,
      teamId: doc.teamId,
      docStatus: doc.status,
      publishTime: this.toIsoDate(doc.publishTime),
    });
    log(
      '3/5',
      `分块完成 chunks=${chunks.length} elapsed=${Date.now() - tChunk}ms`,
    );

    if (!chunks.length) {
      this.logger.warn(
        `[RAG] 完成 traceId=${traceId} docId=${doc.id} ` +
          `分块为空(0 块) 总耗时=${Date.now() - t0}ms`,
      );
      return;
    }

    // ③ 批量嵌入
    const tEmbed = Date.now();
    const embeddings = await this.embeddingService.embedBatch(
      chunks.map((c) => c.content),
    );
    for (let i = 0; i < chunks.length; i++) {
      chunks[i].embedding = embeddings[i];
    }
    log(
      '4/5',
      `嵌入完成 count=${embeddings.length} dims=${embeddings[0]?.length ?? 0} ` +
        `elapsed=${Date.now() - tEmbed}ms`,
    );

    // ④ 写入 ES
    const tIndex = Date.now();
    await this.vectorIndexService.indexChunks(chunks);
    log(
      '5/5',
      `ES 写入完成 indexed=${chunks.length} elapsed=${Date.now() - tIndex}ms`,
    );

    this.logger.log(
      `[RAG] 完成 traceId=${traceId} docId=${doc.id} ` +
        `chunks=${chunks.length} 总耗时=${Date.now() - t0}ms`,
    );
  }

  /** ES date 字段需要 ISO-8601；Date#toString() 会被拒绝 */
  private toIsoDate(value?: Date | string | null): string | null {
    if (value == null) return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  /** 按 ID 列表加载元数据 + Mongo 正文 */
  private async loadDocumentsByIds(ids: string[]): Promise<PipelineDocument[]> {
    const result: PipelineDocument[] = [];
    for (const id of ids) {
      const doc = await this.em.findOne(DocumentEntity, {
        where: { id, deleted: false },
      });
      if (!doc) continue;
      const contentDoc = await this.contentModel
        .findOne({ _id: doc.contentId, deleted: false })
        .lean();
      result.push(this.toPipelineDoc(doc, contentDoc?.content ?? ''));
    }
    return result;
  }

  /** Postgres 实体 + Mongo 正文 → 管线统一 DTO */
  private toPipelineDoc(
    doc: DocumentEntity,
    content: string,
  ): PipelineDocument {
    return {
      id: doc.id,
      title: doc.title,
      content,
      summary: doc.summary,
      categoryId: doc.categoryId,
      authorId: doc.authorId,
      teamId: doc.teamId,
      status: doc.status,
      tags: doc.tags,
      isPublic: doc.isPublic,
      viewCount: doc.viewCount,
      likeCount: doc.likeCount,
      commentCount: doc.commentCount,
      publishTime: doc.publishTime,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}
