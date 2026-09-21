/** RAG 重建 / 删除索引消息 */
export type ReindexType = 'BY_DOC_IDS' | 'DELETE_BY_DOC_IDS';

export interface ReindexMessage {
  taskId: string;
  type: ReindexType;
  documentIds?: string[];
}

/** ES 搜索索引消息（消费者按 documentId 查库后写入 / 删除） */
export type SearchIndexType = 'INDEX' | 'DELETE';

export interface SearchIndexMessage {
  taskId: string;
  type: SearchIndexType;
  documentId: string;
}

/** KG 建图 / 删图消息 */
export type KgBuildType = 'BUILD_ALL' | 'BUILD_BY_DOC_IDS' | 'DELETE_BY_DOC_IDS';

export interface KgBuildMessage {
  taskId: string;
  type: KgBuildType;
  documentIds?: string[];
}
