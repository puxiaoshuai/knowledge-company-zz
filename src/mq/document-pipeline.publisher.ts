import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DocumentEntity } from '../document/entities/document.entity';
import { RAG_REINDEX_EXCHANGE, RAG_RK_BY_IDS } from './mq.constants.js';
import { ReindexMessage } from './messages/pipeline.messages.js';
import { RabbitMqService } from './rabbitmq.service.js';

/**
 * 文档发布后的知识管线「生产者」
 *
 * <p>触发：RAG 向量化。</p>
 * <p>约定：投递失败只打日志，<b>不回滚</b>文档已发布状态。</p>
 */
@Injectable()
export class DocumentPipelinePublisher {
  private readonly logger = new Logger(DocumentPipelinePublisher.name);

  constructor(private readonly rabbit: RabbitMqService) {}

  /** 发布成功后调用：投递 RAG 分块向量化任务 */
  async afterPublish(document: DocumentEntity, traceId: string) {
    await this.triggerRagReindex(document.id, traceId);
  }

  /** RAG：按文档 ID 重建向量块 */
  private async triggerRagReindex(documentId: string, traceId: string) {
    const message: ReindexMessage = {
      taskId: randomUUID(),
      type: 'BY_DOC_IDS',
      documentIds: [documentId],
      traceId,
    };
    const ok = await this.rabbit.publish(
      RAG_REINDEX_EXCHANGE,
      RAG_RK_BY_IDS,
      message,
    );
    this.logger.log(
      `[发布] step=5/6 traceId=${traceId} docId=${documentId} ` +
        `MQ 投递${ok ? '成功' : '失败'} exchange=${RAG_REINDEX_EXCHANGE} ` +
        `rk=${RAG_RK_BY_IDS} taskId=${message.taskId}`,
    );
  }
}
