import { Injectable, Logger } from '@nestjs/common';
import { ConsumeMessage } from 'amqplib';
import { PipelineOrchestrator } from '../pipeline/pipeline.orchestrator';
import { newTraceId } from '../common/trace-id';
import { RAG_REINDEX_QUEUE } from './mq.constants';
import { ReindexMessage } from './messages/pipeline.messages.js';
import { RabbitMqService } from './rabbitmq.service.js';

/**
 * 文档发布后管线的 MQ 消费者
 *
 * <p>消费：RAG 向量化。</p>
 * <p>注册时机：在构造函数里 `registerHandler`，</p>
 * 保证早于 {@link RabbitMqService.onModuleInit} 的 `bindConsumers`。
 */
@Injectable()
export class DocumentPipelineConsumer {
  private readonly logger = new Logger(DocumentPipelineConsumer.name);

  constructor(
    private readonly rabbit: RabbitMqService,
    private readonly orchestrator: PipelineOrchestrator,
  ) {
    this.rabbit.registerHandler(RAG_REINDEX_QUEUE, (msg) =>
      this.handleRag(msg),
    );
  }

  /** RAG：分块 → 向量化 → ES kh_chunk（dense_vector） */
  private async handleRag(msg: ConsumeMessage) {
    const body = this.parseJson<ReindexMessage>(msg);

    // 旧格式消息（发布端未带 traceId）兜底生成，保证消费段仍可追踪
    let traceId = body.traceId;
    if (!traceId) {
      traceId = newTraceId();
      this.logger.warn(
        `[RAG] step=1/5 traceId=${traceId} 消息未带 traceId（旧格式），已兜底生成 taskId=${body.taskId}`,
      );
    }

    this.logger.log(
      `[RAG] step=1/5 traceId=${traceId} 收到消息 ` +
        `type=${body.type} taskId=${body.taskId} ` +
        `documentIds=${JSON.stringify(body.documentIds ?? [])}`,
    );
    await this.orchestrator.handleRagReindex(
      body.type,
      body.documentIds,
      traceId,
    );
  }

  private parseJson<T>(msg: ConsumeMessage): T {
    return JSON.parse(msg.content.toString('utf8')) as T;
  }
}
