import { Client } from '@elastic/elasticsearch';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** ES 文档级全文检索索引名 */
const ES_INDEX = 'kh_document';

/** 关键词检索参数 */
export interface SearchParams {
  /** 关键词，匹配标题/摘要/正文；为空则只按过滤条件分页 */
  keyword?: string;
  /** 页码，从 1 开始 */
  page?: number;
  /** 每页条数，1~100 */
  pageSize?: number;
  /** 分类 ID 过滤 */
  categoryId?: string;
  /** 作者 ID 过滤 */
  authorId?: string;
}

/** 检索结果条目：索引字段 + 高亮片段 */
export interface SearchHitItem extends Record<string, unknown> {
  highlight?: Record<string, string[]>;
}

/** 关键词检索结果 */
export interface SearchResult {
  total: number;
  page: number;
  pageSize: number;
  list: SearchHitItem[];
}

/**
 * 文档级全文搜索索引
 *
 * <p>与 RAG 向量索引的区别：</p>
 * - 这里是「整篇文档」一条记录（标题/摘要/正文前缀），给关键词搜索用
 * - RAG 是「多块 + 向量」，给语义检索用
 *
 * <p>仅写入 Elasticsearch `kh_document`；ES 不可用时跳过写入并打日志。</p>
 */
@Injectable()
export class SearchIndexService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SearchIndexService.name);
  private es: Client | null = null;
  private readonly esEnabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.esEnabled =
      this.config.get<string>('ELASTICSEARCH_ENABLED', 'true') !== 'false';
  }
  /** 中文：写入细切（ik_max_word），检索粗切（ik_smart） */
  private readonly ikText = {
    type: 'text' as const,
    analyzer: 'ik_max_word',
    search_analyzer: 'ik_smart',
  };

  async onModuleInit() {
    if (!this.esEnabled) {
      this.logger.warn('Elasticsearch 已禁用，搜索索引将跳过写入');
      return;
    }

    const node = this.config.get(
      'ELASTICSEARCH_NODE',
      'http://localhost:9200',
    );
    this.es = new Client({ node });
    try {
      const health = await this.es.cluster.health();
      this.logger.log(`SearchIndex ES 已连接：${node}, status=${health.status}`);
      await this.ensureEsIndex();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Elasticsearch 不可用，搜索索引将跳过写入：${message}`);
      this.es = null;
    }
  }

  async onModuleDestroy() {
    await this.es?.close();
  }

  /**
   * Upsert 一篇文档的搜索记录。
   * @param doc 字段约定见 PipelineOrchestrator.toSearchDoc
   */
  async indexDocument(doc: Record<string, unknown>) {
    if (!this.es) {
      this.logger.warn(
        `跳过搜索索引写入（ES 不可用）：documentId=${String(doc.id)}`,
      );
      return;
    }

    const id = String(doc.id);
    await this.es.index({
      index: ES_INDEX,
      id,
      document: {
        ...doc,
        indexedAt: new Date().toISOString(),
      },
      refresh: true,
    });

    this.logger.log(`搜索索引已写入 ES：documentId=${id}`);
  }

  /** 下架 / 删除时从 ES 移除 */
  async deleteDocument(documentId: string) {
    if (!this.es) {
      this.logger.warn(
        `跳过搜索索引删除（ES 不可用）：documentId=${documentId}`,
      );
      return;
    }

    try {
      await this.es.delete({
        index: ES_INDEX,
        id: documentId,
        refresh: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('404')) {
        this.logger.warn(`ES 删除失败：documentId=${documentId}, ${message}`);
      }
    }

    this.logger.log(`搜索索引已删除：documentId=${documentId}`);
  }

  /**
   * 关键词检索文档。
   *
   * <p>keyword 走 multi_match（标题/摘要/正文加权），categoryId / authorId 走 term 精确过滤；
   * 命中字段以 &lt;em&gt; 标签高亮返回（标题返回整段，摘要/正文返回片段）。
   * ES 不可用或查询失败时返回空结果并打日志。</p>
   */
  async searchDocuments(params: SearchParams = {}): Promise<SearchResult> {
    const page = Math.max(1, Math.floor(params.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize ?? 10)));
    const result: SearchResult = { total: 0, page, pageSize, list: [] };

    if (!this.es) {
      this.logger.warn('跳过关键词检索（ES 不可用）');
      return result;
    }

    const filters: Record<string, unknown>[] = [];
    if (params.categoryId) {
      filters.push({ term: { categoryId: params.categoryId } });
    }
    if (params.authorId) {
      filters.push({ term: { authorId: params.authorId } });
    }

    const keyword = params.keyword?.trim();
    const query: Record<string, unknown> = filters.length > 0
      ? {
        bool: {
          must: [
            {
              multi_match: {
                query: keyword,
                fields: ['title^3', 'summary^2', 'content'],
                analyzer: 'ik_smart',
              },
            },
          ],
          filter: filters,
        },
      }
      : {
        multi_match: {
          query: keyword,
          fields: ['title^3', 'summary^2', 'content'],
          analyzer: 'ik_smart',
        },
      };

    try {
      const response = await this.es.search({
        index: ES_INDEX,
        from: (page - 1) * pageSize,
        size: pageSize,
        query,
        highlight: {
          pre_tags: ['<em>'],
          post_tags: ['</em>'],
          fields: {
            title: { number_of_fragments: 0 },
            summary: { fragment_size: 100, number_of_fragments: 2 },
            content: { fragment_size: 100, number_of_fragments: 2 },
          },
        },
      });

      result.total =
        typeof response.hits.total === 'number'
          ? response.hits.total
          : (response.hits.total?.value ?? 0);
      result.list = response.hits.hits.map((hit) => ({
        ...(hit._source as Record<string, unknown>),
        highlight: hit.highlight,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`关键词检索失败：${message}`);
    }

    return result;
  }

  /** 索引不存在则创建基础 mapping（text + keyword） */
  private async ensureEsIndex() {
    if (!this.es) return;
    const exists = await this.es.indices.exists({ index: ES_INDEX });
    if (!exists) {
      await this.es.indices.create({
        index: ES_INDEX,
        mappings: {
          properties: {
            id: { type: 'keyword' },
            title: this.ikText,
            summary: this.ikText,
            content: this.ikText,
            tags: { type: 'keyword' },
            status: { type: 'integer' },
            categoryId: { type: 'keyword' },
            authorId: { type: 'keyword' },
            publishTime: { type: 'date' },
          },
        },
      });
      this.logger.log(`已创建 ES 索引：${ES_INDEX}（ik_max_word / ik_smart）`);
    }
  }
}
