/** RAG 重建索引消息 */
export type ReindexType = 'BY_DOC_IDS';

export interface ReindexMessage {
  taskId: string;
  type: ReindexType;
  documentIds?: string[];
  /**
   * 链路追踪 ID，由发布入口生成并透传到消费端。
   * 可选：兼容不带该字段的旧消息，消费端会自行兜底生成。
   */
  traceId?: string;
}
