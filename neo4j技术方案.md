# 知识图谱（Neo4j）技术方案

> 目标：在现有「发布 → MQ 异步管线」基础上，新增第三条链路，完成**分块实体关系抽取 → 实体消歧 → 图谱构建 → 图上检索**，为后续 GraphRAG 问答提供多跳能力。
>
> 状态：设计稿（未实现）。当前 compose 中 Neo4j 容器已就位。

---

## 目录

- [1. 背景与目标](#1-背景与目标)
- [2. 现状与落点](#2-现状与落点)
- [3. 总体架构](#3-总体架构)
- [4. 本体设计（先定死）](#4-本体设计先定死)
- [5. 抽取实现](#5-抽取实现)
- [6. 实体消歧](#6-实体消歧)
- [7. 存储建模](#7-存储建模)
- [8. 增量更新与删除](#8-增量更新与删除)
- [9. 检索应用（GraphRAG）](#9-检索应用graphrag)
- [10. 配置与成本控制](#10-配置与成本控制)
- [11. 实施路线](#11-实施路线)
- [12. 风险与已知坑](#12-风险与已知坑)

---

## 1. 背景与目标

### 为什么需要知识图谱

现有检索能力是**平面**的：ES `kh_document` 做全文匹配，ES `kh_chunk` 做向量相似度。两者都只能回答「哪些片段和问题像」，无法回答「A 和 B 是什么关系」「A 挂了会影响谁」这类需要**跨文档、多跳**的问题。

知识图谱补的正是这一块：

| 能力 | 全文检索 | 向量检索 | 知识图谱 |
| --- | --- | --- | --- |
| 关键词精确匹配 | ✅ | ⚠️ | — |
| 语义相似召回 | ⚠️ | ✅ | — |
| 实体关系查询 | ❌ | ❌ | ✅ |
| 多跳推理 | ❌ | ❌ | ✅ |
| 结果可解释 | ⚠️ | ❌ | ✅（边上带证据） |

### 目标

1. 发布文档后异步抽取实体与关系，写入 Neo4j
2. 同一实体跨文档合并（消歧），形成全局图
3. 每条边、每个实体都能**溯源到原文 chunk**
4. 检索侧支持实体链接 + 子图检索，供 RAG 使用
5. 全文/向量/图谱三路召回可融合

### 非目标（本阶段不做）

- 社区检测 + 全局摘要（GraphRAG Global Search）—— 放到 P6
- 图神经网络 / 链接预测
- 实时增量抽取（仍走批量异步）

---

## 2. 现状与落点

### 现有发布流程

```
PUT /documents/:id/publish
        │
        ▼
DocumentPipelinePublisher          ← 投递失败只记日志，不回滚发布状态
        │
   ┌────┴────┐
   │         │
   ▼         ▼
rag.reindex  search.index
.exchange    .exchange
   │         │
   ▼         ▼
ES kh_chunk  ES kh_document
```

### 新增第三条链路

| 链路 | Exchange | 路由键 | 消费后落库 |
| --- | --- | --- | --- |
| RAG | `rag.reindex.exchange` | `rag.reindex.by_ids` | ES `kh_chunk` |
| Search | `search.index.exchange` | `search.index.document` | ES `kh_document` |
| **KG（新增）** | `kg.extract.exchange` | `kg.extract.by_doc_ids` | Neo4j |

**为什么是独立链路，而不是塞进 RAG 链路？**

1. **成本与失败率差异数量级**：LLM 抽取比 embedding 贵两个数量级，失败率也高得多。混在一条链路里，RAG 重建会被 LLM 的限流和重试拖垮。
2. **更新频率不同**：换 embedding 模型要重跑 RAG，但不该重跑 LLM 抽取；改本体 / 换抽取模型要重跑 KG，也不该动向量索引。
3. **抽取粒度可能不同**：当前 RAG 按 512 token 切块，KG 未来可能想按小节整体抽，独立链路可以传不同的分块参数。

**抽取单元直接复用 `ChunkingService`**，输入走 `PipelineDocument`，与 `PipelineOrchestrator.handleRagReindex` 保持同一形状，不引入新的加载逻辑。

### 新增文件清单

```
src/pipeline/
  entity-extraction.service.ts        # LLM 抽取 + 规则校验
  graph-index.service.ts              # Neo4j 写入/删除（对应 vector-index.service.ts）
src/knowledge-graph/
  ontology.ts                         # 实体/关系类型白名单
  entity-resolution.service.ts        # 归一化与消歧
  graph-query.service.ts              # 图查询
  knowledge-graph.module.ts
  knowledge-graph.controller.ts       # 图查询 HTTP 接口
src/mq/
  kg.consumer.ts                      # MQ 消费者
  messages/kg.messages.ts             # 消息体定义
```

改造点：

- `src/mq/mq.constants.ts` —— 新增 exchange / queue / routingKey 常量
- `src/mq/document-pipeline.publisher.ts` —— 发布时多投一条 KG 消息
- `src/pipeline/pipeline.orchestrator.ts` —— 新增 `handleKgExtract(type, documentIds)`
- `src/pipeline/pipeline.module.ts` —— 注册新 service
- `init-scripts/postgresql/init.sql` —— 新增 `kg_extraction` 表

### 新增依赖

```bash
pnpm add neo4j-driver
```

LLM 走 `@langchain/openai` 的 `ChatOpenAI`（已在依赖里，与 EmbeddingService 同一套配置模式，DashScope 兼容模式）。

---

## 3. 总体架构

```
                    PUT /documents/:id/publish
                              │
              DocumentPipelinePublisher（三条链路并行投递）
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
rag.reindex.exchange  search.index.exchange  kg.extract.exchange
        │                     │                     │
        ▼                     ▼                     ▼
PipelineOrchestrator   SearchIndexService    KgConsumer
.handleRagReindex                            · 分块（复用 ChunkingService）
        │                                    · 逐块查 kg_extraction 缓存
        │                                    · 未命中 → LLM 抽取
        │                                    · 规则校验（三道）
        │                                    · 实体归一化 + 消歧
        │                                    · 写 Neo4j
        ▼                                          ▼
   ES kh_chunk                              Neo4j
                                            (:Entity)-[:关系]->(:Entity)
                                                   │
                                            (:Chunk)-[:PART_OF]->(:Document)
```

### 四层存储分工

| 层 | 存储 | 内容 | 是否可重建 |
| --- | --- | --- | --- |
| 原始层 | PG `kg_extraction` | LLM 原始 JSON 输出 | **不可变，是重建源** |
| 主数据层 | PG `kg_entity` / `kg_relation` | 归一化实体与关系、审核状态（P3+） | 可从原始层重建 |
| 图层 | Neo4j | 查询用投影 | 可从上面两层重建 |
| 检索层 | ES `kh_entity` | 实体名 + 别名 + 描述（IK）| 可从主数据重建 |

> **原始层绝对不要砍。** 它是「改图模型 / 改消歧算法 / Neo4j 数据损坏」时唯一的免烧 token 重放源，同时兼作审核队列和问题排查数据源。详见 [7.1](#71-原始层-postgres-必做)。

---

## 4. 本体设计（先定死）

### 为什么必须闭集

**不要做开放式抽取。** 让 LLM 自由发明类型，跑完 100 篇文档你会得到两千种类型名、同义关系混用（"负责" / "担任" / "主管" / "负责管理"），图根本没法查。

类型不够用就人工加——**加类型是低频操作，比事后清洗便宜太多**。

### `src/knowledge-graph/ontology.ts`

```ts
/**
 * 知识图谱本体定义
 *
 * 这份白名单同时承担三个职责：
 * 1. 作为 LLM 抽取 prompt 的枚举约束
 * 2. 作为抽取结果的规则校验白名单
 * 3. 作为 Neo4j 边类型的允许集合（关系类型直接做边类型）
 *
 * 修改本文件后必须递增 KG_PROMPT_VERSION，否则抽取缓存不会失效。
 */

export const ENTITY_TYPES = {
  PERSON: '人员',
  ORG: '组织',
  DEPT: '部门',
  PRODUCT: '产品',
  TECH: '技术',
  PROJECT: '项目',
  CONCEPT: '概念',
  PROCESS: '流程',
  METRIC: '指标',
  EVENT: '事件',
  TERM: '术语',
} as const;

export type EntityType = keyof typeof ENTITY_TYPES;

export const RELATION_TYPES = {
  BELONGS_TO: '隶属于',
  MANAGES: '负责',
  PARTICIPATES: '参与',
  DEPENDS_ON: '依赖',
  USES: '使用',
  CONTAINS: '包含',
  REPLACES: '替代',
  CAUSES: '导致',
  PREREQUISITE: '先决于',
  RELATED_TO: '相关',
} as const;

export type RelationType = keyof typeof RELATION_TYPES;

/** prompt 里渲染的枚举文案：`PERSON(人员)、ORG(组织)、...` */
export const entityTypeEnumText = Object.entries(ENTITY_TYPES)
  .map(([k, v]) => `${k}(${v})`)
  .join('、');

export const relationTypeEnumText = Object.entries(RELATION_TYPES)
  .map(([k, v]) => `${k}(${v})`)
  .join('、');

export const isEntityType = (v: string): v is EntityType => v in ENTITY_TYPES;
export const isRelationType = (v: string): v is RelationType => v in RELATION_TYPES;

/** 中文标签 → 类型键，用于 LLM 偶尔返回中文名而非英文键时的容错 */
export const entityTypeCnToKey: Record<string, EntityType> = Object.fromEntries(
  Object.entries(ENTITY_TYPES).map(([k, v]) => [v, k as EntityType]),
);
```

### 本体扩展规则

| 情况 | 做法 |
| --- | --- |
| 新领域（如法务、财务） | 新增实体类型，如 `CONTRACT`、`CLAUSE` |
| 同义关系（"担任" ≈ "负责"） | 归并到已有类型，写进 prompt 的反例说明 |
| 一次性关系 | 用 `RELATED_TO` 兜底，不新增类型 |
| 层级关系（上下位） | 用 `CONTAINS` + 图上的路径查询表达，不新增 |

---

## 5. 抽取实现

### 5.1 抽取输入

复用 `ChunkingService` 产出的 `DocumentChunk`——它的 `content` 已经带了 heading 上下文前缀（跨块继承补全），正好是抽取需要的上下文。

```
文档标题：{documentTitle}
所属章节：{heading}
正文：
{content}
```

### 5.2 Prompt 模板

```
你是一个企业知识库的信息抽取引擎。从给定正文中抽取实体与关系。

文档标题：{documentTitle}
所属章节：{heading}

正文：
"""
{content}
"""

抽取规则：
1. 只抽取正文中**明确出现**的事实，禁止推理、补全、跨段联想
2. 实体类型必须从下列枚举中选择，不得自创：
   {entityTypeEnumText}
3. 关系类型必须从下列枚举中选择，不得自创：
   {relationTypeEnumText}
4. 每个实体必须给出 evidence 字段，逐字复制正文中的原文片段作为依据
5. 关系的 source / target 必须同时在本段正文中出现过
6. 关系必须给出 evidence 字段
7. 同一实体在正文中出现多次时只输出一次，aliases 里记录其他称谓
8. 没有可抽取的内容时返回空数组，不要硬凑

输出 JSON，格式：
{
  "entities": [
    { "name": "订单服务", "type": "PRODUCT", "aliases": ["订单中心","order-service"],
      "description": "负责订单创建与状态流转的服务", "evidence": "订单服务负责..." }
  ],
  "relations": [
    { "source": "订单服务", "target": "库存服务", "type": "DEPENDS_ON",
      "description": "下单时校验库存", "evidence": "订单服务依赖库存服务..." }
  ]
}
```

### 5.3 结构化输出

两种做法，推荐前者：

**A. LangChain `withStructuredOutput`**（推荐）

```ts
const schema = z.object({
  entities: z.array(z.object({
    name: z.string(),
    type: z.string(),
    aliases: z.array(z.string()).default([]),
    description: z.string().default(''),
    evidence: z.string().default(''),
  })),
  relations: z.array(z.object({
    source: z.string(),
    target: z.string(),
    type: z.string(),
    description: z.string().default(''),
    evidence: z.string().default(''),
  })),
});

const structured = this.chatModel.withStructuredOutput(schema, {
  name: 'extract_knowledge',
});
const result = await structured.invoke(prompt);
```

好处：schema 校验失败时框架自动重试，省掉手写 JSON 解析容错。

**B. 裸 OpenAI 兼容接口**

`response_format: { type: 'json_object' }` + prompt 里贴 JSON schema。DashScope 的 `qwen-plus` / `qwen-max` 两种方式都支持。

### 5.4 规则校验（必须有）

LLM 一定会编。抽取结果写图之前过三道零成本校验：

```ts
private validate(chunk: DocumentChunk, raw: RawExtraction): ValidatedExtraction {
  // ① 实体名必须是原文子串（防幻觉编造实体）
  const entities = raw.entities.filter((e) => {
    if (!chunk.content.includes(e.name)) return false;
    // ② 类型必须在白名单内（模型偶尔自创类型）
    if (!isEntityType(e.type)) return false;
    // ③ 名字不能是纯标点 / 超长（防垃圾提取）
    if (e.name.trim().length < 2 || e.name.length > 100) return false;
    return true;
  });

  const names = new Set(entities.map((e) => e.name));

  // ④ 关系两端实体必须都在本 chunk 的实体集合里
  const relations = raw.relations.filter((r) =>
    names.has(r.source) &&
    names.has(r.target) &&
    r.source !== r.target &&          // 防自环
    isRelationType(r.type),
  );

  return { entities, relations };
}
```

**校验失败率要打点上报。** 持续高于 20% 说明 prompt 或模型该调了，不要闷头跑。

### 5.5 抽取缓存（关键设计）

**缓存键必须包含内容哈希，不能用 chunkId。** 原因见 [12.1](#121-chunkid-不稳定会污染抽取缓存)。

```ts
// ✅ 正确
const extractKey = createHash('sha256')
  .update(`${promptVersion}:${model}:${chunk.content}`)
  .digest('hex');
```

命中缓存 → 直接取 `raw_result`，跳过 LLM 调用。

### 5.6 EntityExtractionService 骨架

```ts
@Injectable()
export class EntityExtractionService {
  private readonly logger = new Logger(EntityExtractionService.name);
  private readonly chatModel: ChatOpenAI | null = null;
  private readonly promptVersion: string;
  private readonly maxRetry: number;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(KgExtractionEntity)
    private readonly extractionRepo: Repository<KgExtractionEntity>,
  ) {
    const apiKey = config.get('KG_LLM_API_KEY') || config.get('DASHSCOPE_API_KEY');
    if (!apiKey) {
      this.logger.warn('未配置 KG_LLM_API_KEY，知识图谱抽取将跳过');
      return;
    }
    this.chatModel = new ChatOpenAI({
      apiKey,
      model: config.get('KG_LLM_MODEL', 'qwen-plus'),
      temperature: 0,      // 抽取任务必须 0，否则结果不可复现
      configuration: {
        baseURL: config.get('KG_LLM_BASE_URL',
          'https://dashscope.aliyuncs.com/compatible-mode/v1'),
      },
    });
    this.promptVersion = config.get('KG_PROMPT_VERSION', 'v1');
    this.maxRetry = Number(config.get('KG_MAX_RETRY', 2));
  }

  /** 单块抽取：查缓存 → 未命中调 LLM → 规则校验 → 回写缓存 */
  async extractChunk(chunk: DocumentChunk): Promise<ValidatedExtraction> {
    if (!this.chatModel) return { entities: [], relations: [] };

    const key = this.buildCacheKey(chunk.content);

    const cached = await this.extractionRepo.findOne({ where: { extractKey: key } });
    if (cached && cached.status === 0) {
      return cached.rawResult as ValidatedExtraction;
    }

    const raw = await this.invokeLlmWithRetry(chunk);
    const validated = this.validate(chunk, raw);

    await this.saveCache(key, validated);
    return validated;
  }

  /** 失败重试；重试耗尽返回空结果，不阻断整篇文档 */
  private async invokeLlmWithRetry(chunk: DocumentChunk): Promise<RawExtraction> { /* ... */ }
}
```

**注意 `temperature: 0`** —— 抽取是确定性任务，温度不为 0 会导致同一 chunk 两次抽取结果不同，缓存和幂等都失去意义。

---

## 6. 实体消歧

这是图谱质量的**天花板**所在。分四层，从便宜到贵，逐层递进。

### L1 确定性归一化（零成本，先做）

```ts
/**
 * 实体名归一化：生成合并用的稳定键
 * 注意：只做形式归一，不做语义归一（不做同义词替换）
 */
export function normalizeEntityName(raw: string): string {
  return raw
    .normalize('NFKC')            // 全角转半角
    .replace(/\s+/g, '')          // 去所有空白（中文实体名内空白无意义）
    .replace(/[（）()【】\[\]]/g, '') // 去括号
    .toLowerCase();               // 英文小写
}
```

实体唯一键 = `(type, normalizedName)`，对应 Neo4j 唯一约束。

```ts
normalizeEntityName(' 订单 服务 ')  // → '订单服务'
normalizeEntityName('Order Service') // → 'orderservice'
```

### L2 别名表

抽取时 LLM 顺带输出 `aliases: ['订单中心', 'order-service', 'OS']`，写进实体的 `aliases` 数组，同时索引进 ES `kh_entity` 供实体链接使用。

### L3 向量最近邻 + LLM 二判

处理「订单服务」vs「订单中心」vs「Order Service」这类**同一实体的不同正式称谓**。

流程：

1. 用已有的 `EmbeddingService` 对 `name + description` 做嵌入（复用，不新增服务）
2. Neo4j 向量索引 topK = 10，取 cosine > 0.85 的候选
3. **候选不自动合并**，交给 LLM 二判：

```
判断下面两个实体是否指同一事物：

A: 名称={a.name}, 类型={a.type}, 描述={a.description}
B: 名称={b.name}, 类型={b.type}, 描述={b.description}

只回答 SAME / DIFFERENT / UNCERTAIN 之一，不要解释。
不确定时回答 UNCERTAIN。
```

4. `SAME` → 合并；`UNCERTAIN` → 进人工审核队列

> ⚠️ **绝对不要按向量相似度自动合并。** 0.9 相似度也可能是「订单服务」和「订单系统」这种上下游关系，自动合并会把图搞烂，而且**不可逆**。

### L4 人工审核

- `kg_extraction.status = 2` 的抽取结果
- L3 判定为 `UNCERTAIN` 的候选对

做成后台列表页，人工确认 / 否决 / 改判。

### 合并操作的坑：自环

合并 A 和 B 之后，原本 `A -[:DEPENDS_ON]-> B` 的边会变成 `A -[:DEPENDS_ON]-> A`。

```cypher
// 合并前先查自环风险
MATCH (a:Entity {id: $aId})-[r]->(b:Entity {id: $bId})
RETURN type(r) AS relType, r.evidence AS evidence
// 自环处理：删除，或把关系语义改写成 A 的属性
```

**这个 bug 很容易漏**，合并逻辑写完之后一定要拿一组互为依赖的实体对测。

### 合并实现

```cypher
// 1. 搬 MENTIONED_IN（A 已有则跳过）
MATCH (b:Entity {id: $bId})-[mb:MENTIONED_IN]->(c:Chunk)
MATCH (a:Entity {id: $aId})
MERGE (a)-[ma:MENTIONED_IN]->(c)
  ON CREATE SET ma = properties(mb)
DELETE mb;

// 2. 搬出边 / 入边（按实体对聚合，注意自环）
MATCH (b)-[r]->(other) WHERE other.id <> $aId ...
// 3. 合并 aliases / description / docCount
// 4. DETACH DELETE (b)
```

建议把整个合并包在 `session.executeWrite` 事务里。

---

## 7. 存储建模

### 为什么不建议只存 Neo4j

Neo4j 社区版缺细粒度权限、备份麻烦，而且实体主数据要跟 Postgres 里的文档元数据做 join、要做人工审核流转。

### 7.1 原始层：Postgres（必做）

```sql
-- init-scripts/postgresql/init.sql

CREATE TABLE IF NOT EXISTS kg_extraction (
  extract_key    VARCHAR(64)  PRIMARY KEY,   -- sha256(promptVersion:model:content)
  prompt_version VARCHAR(32)  NOT NULL,
  model          VARCHAR(64)  NOT NULL,
  document_id    BIGINT,                     -- 便于按文档批量查/清
  chunk_id       VARCHAR(64),
  content        TEXT,                       -- 原文，便于人工比对（可选，占空间）
  raw_result     JSONB        NOT NULL,      -- 校验后的抽取结果，图可从它重建
  status         SMALLINT     NOT NULL DEFAULT 0,  -- 0成功 1失败 2待审核
  error_message  TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kg_extraction_doc ON kg_extraction (document_id);
CREATE INDEX IF NOT EXISTS idx_kg_extraction_status ON kg_extraction (status);
```

**这张表是整个方案里性价比最高的一处设计**：

- 改图模型、改消歧算法、Neo4j 数据损坏 → 从 `raw_result` 重放，**不重新烧 token**
- 兼作人工审核队列（`status = 2`）
- 兼作抽取质量的问题排查数据源

### 7.2 检索层：ES `kh_entity`

沿用 `VectorIndexService.createIndexIfNotExists` 的模式：

```json
{
  "mappings": {
    "properties": {
      "entity_id":       { "type": "keyword" },
      "name":            { "type": "text", "analyzer": "ik_max_word",
                           "search_analyzer": "ik_smart",
                           "fields": { "keyword": { "type": "keyword" } } },
      "aliases":         { "type": "text", "analyzer": "ik_max_word" },
      "type":            { "type": "keyword" },
      "description":     { "type": "text", "analyzer": "ik_max_word" },
      "doc_count":       { "type": "integer" },
      "embedding":       { "type": "dense_vector", "dims": 1024,
                           "index": true, "similarity": "cosine" }
    }
  }
}
```

> 注意这里的 IK 分析器是**显式配置**的。现有 `kh_document` / `kh_chunk` 的 mapping 都没配（README 已知缺口），中文分词实际未生效——建新索引时别再犯同一个错。

用途：查询词 → 实体链接（精确名 → 别名 → 向量兜底）。

### 7.3 图层：Neo4j

#### 约束与索引

```cypher
// 实体唯一键：类型 + 归一化名
CREATE CONSTRAINT entity_key IF NOT EXISTS
FOR (e:Entity) REQUIRE (e.type, e.normalizedName) IS UNIQUE;

CREATE CONSTRAINT entity_id IF NOT EXISTS
FOR (e:Entity) REQUIRE e.id IS UNIQUE;

CREATE CONSTRAINT document_id IF NOT EXISTS
FOR (d:Document) REQUIRE d.id IS UNIQUE;

CREATE CONSTRAINT chunk_id IF NOT EXISTS
FOR (c:Chunk) REQUIRE c.id IS UNIQUE;

// 实体消歧用的向量索引（需 Neo4j 5.11+，neo4j:latest 已满足）
CREATE VECTOR INDEX entity_embedding IF NOT EXISTS
FOR (e:Entity) ON (e.embedding)
OPTIONS { indexConfig: {
  `vector.dimensions`: 1024,
  `vector.similarity_function`: 'cosine'
}};

// 按类型查实体
CREATE INDEX entity_type IF NOT EXISTS FOR (e:Entity) ON (e.type);
```

#### 节点与边

```
(:Entity   {id, name, normalizedName, type, description, aliases,
            embedding, docCount, orphan, createdAt, updatedAt})

(:Chunk    {id, documentId, documentTitle, heading, chunkIndex})

(:Document {id, title})

(Entity)-[:MENTIONED_IN {confidence, promptVersion}]->(Chunk)     // 溯源
(Chunk)-[:PART_OF]->(Document)
(Entity)-[:负责|依赖|使用|...  {evidence[], docIds[], chunkIds[],
                              confidence, updatedAt}]->(Entity)
```

#### 两个建模决定

**① 关系类型直接做边类型**（`-[:DEPENDS_ON]->`），不要统一用 `-[:RELATES_TO {type:'DEPENDS_ON'}]->`。

- 优点：Cypher 可读性和查询性能都好得多。`MATCH (a)-[:DEPENDS_ON*1..3]->(b)` 能直接写。
- 代价：关系类型必须来自白名单——而这本来就是你该做的（见第 4 节）。
- 动态边类型用已安装的 APOC：

```cypher
CALL apoc.merge.relationship(src, $relType, {}, $props, tgt, $onCreateProps)
YIELD rel
RETURN rel
```

**② 关系边按「实体对」聚合，不按 chunk 各存一条。**

同一对实体在 20 个 chunk 里都被提到「A 依赖 B」，应该是**一条边带证据数组**，不是 20 条平行边：

```cypher
(:Entity {name:'订单服务'})-[:DEPENDS_ON {
  evidence:  ['...原文片段1...', '...原文片段2...'],
  docIds:    ['1687...', '1688...'],
  chunkIds:  ['a3f2...', 'b7e1...'],
  confidence: 0.92,
  updatedAt: datetime()
}]->(:Entity {name:'库存服务'})
```

好处：删文档时能精确从数组里摘掉该文档的证据，数组空了再删边（见第 8 节）。

#### 幂等写入

整篇文档的写入包在一个事务里（`session.executeWrite`）：

```cypher
MERGE (d:Document {id: $documentId})
  SET d.title = $title

MERGE (c:Chunk {id: $chunkId})
  SET c.documentId = $documentId,
      c.documentTitle = $documentTitle,
      c.heading = $heading,
      c.chunkIndex = $chunkIndex
MERGE (c)-[:PART_OF]->(d)

WITH c
UNWIND $entities AS ent
  MERGE (e:Entity {type: ent.type, normalizedName: ent.normalizedName})
    ON CREATE SET e.id = ent.id,
                  e.name = ent.name,
                  e.aliases = ent.aliases,
                  e.description = ent.description,
                  e.createdAt = datetime()
    ON MATCH  SET e.name = coalesce(e.name, ent.name),
                  e.aliases = apoc.coll.toSet(coalesce(e.aliases, []) + ent.aliases),
                  e.updatedAt = datetime()
  MERGE (e)-[m:MENTIONED_IN]->(c)
    SET m.confidence = ent.confidence,
        m.promptVersion = $promptVersion
```

`MERGE` 落在 `(type, normalizedName)` 唯一约束上，天然并发安全——多个文档同时提到「订单服务」不会写出两个节点。

### 7.4 GraphIndexService 骨架

对应现有的 `VectorIndexService`，保持同样的 `@Injectable() + onModuleInit/onModuleDestroy + 降级不阻断` 风格：

```ts
@Injectable()
export class GraphIndexService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GraphIndexService.name);
  private driver: Driver | null = null;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.enabled = config.get('NEO4J_ENABLED', 'true') !== 'false';
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('Neo4j 已禁用，知识图谱写入将跳过');
      return;
    }
    const uri = this.config.get('NEO4J_URI', 'bolt://localhost:7687');
    this.driver = neo4j.driver(
      uri,
      neo4j.auth.basic(
        this.config.get('NEO4J_USER', 'neo4j'),
        this.config.get('NEO4J_PASSWORD', ''),
      ),
    );
    try {
      await this.driver.verifyConnectivity();
      await this.ensureConstraints();
      this.logger.log(`Neo4j 已连接：${uri}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Neo4j 不可用，图谱写入将跳过：${message}`);
      await this.driver.close();
      this.driver = null;   // 与 VectorIndexService 一致的降级策略
    }
  }

  async onModuleDestroy() {
    await this.driver?.close();
  }

  /** 按文档写入（幂等，重复发布不产生脏数据） */
  async upsertDocument(documentId: string, chunks: ChunkExtractionResult[]) { /* ... */ }

  /** 按文档删除（见第 8 节） */
  async deleteByDocId(documentId: string) { /* ... */ }
}
```

---

## 8. 增量更新与删除

复用现有「先删后建」（`deleteByDocId → 重建`）模式，与 RAG 链路一致。

### 8.1 按文档删除

```cypher
// 1. 摘掉实体对该文档所有 chunk 的提及
MATCH (d:Document {id: $documentId})<-[:PART_OF]-(c:Chunk)
OPTIONAL MATCH (:Entity)-[m:MENTIONED_IN]->(c)
DELETE m;

// 2. 从关系边的证据数组里摘掉该文档，数组空了删边
MATCH ()-[r]->()
WHERE r.docIds IS NOT NULL AND $documentId IN r.docIds
SET r.docIds   = [x IN r.docIds   WHERE x <> $documentId],
    r.chunkIds = [x IN r.chunkIds WHERE NOT x IN $affectedChunkIds]
// 数组清空则删除该边（需在应用层判断，或分两步 Cypher）

// 3. 删除 chunk 节点
MATCH (d:Document {id: $documentId})<-[:PART_OF]-(c:Chunk)
DETACH DELETE c;

// 4. 文档没有 chunk 了则删文档节点
MATCH (d:Document {id: $documentId})
WHERE NOT (d)<-[:PART_OF]-()
DELETE d;
```

### 8.2 孤儿实体处理

不再被任何 chunk 提及的实体**别急着 `DELETE`**：

> ⚠️ 它可能还挂着关系边。`DETACH DELETE` 会把那些边一起干掉，而那些边可能还有**别的文档**在支撑。这是最容易造成静默数据丢失的一处。

正确做法是**打标**：

```cypher
MATCH (e:Entity)
WHERE NOT (e)-[:MENTIONED_IN]->()
SET e.orphan = true, e.orphanedAt = datetime()
```

查询时默认过滤 `WHERE e.orphan IS NULL OR e.orphan = false`。

定期任务清理 orphan 超过 N 天**且没有任何关系边**的实体：

```cypher
MATCH (e:Entity {orphan: true})
WHERE e.orphanedAt < datetime() - duration({days: 30})
  AND NOT (e)--()
DELETE e
```

### 8.3 增量抽取的粒度

当前设计是**按文档全量重建**（删旧图 → 重新抽取整篇）。因为分块边界会随编辑漂移，做不到稳定的 chunk 级增量。

优化空间（后续）：抽取缓存键是内容哈希，所以重新发布时**未改动的 chunk 会命中缓存，只有改动部分真正调用 LLM**。这已经在成本上等价于增量了，不需要更细的粒度。

---

## 9. 检索应用（GraphRAG）

### 9.1 实体链接

把用户查询映射到图上节点：

```
查询："订单服务挂了会影响哪些下游？"
  │
  ├─ ① ES kh_entity 精确匹配 name / aliases      → 命中「订单服务」
  ├─ ② 未命中 → 向量相似度 topK（复用 embedding）  → 候选实体
  └─ ③ 仍未命中 → 放弃图谱路径，退回纯 RAG
```

### 9.2 Local Search（先做）

从链接到的实体出发，取 1~2 跳邻域 + 关联 chunk 原文：

```cypher
MATCH (a:Entity {id: $entityId})
MATCH path = (a)-[r:DEPENDS_ON|USES|CAUSES*1..2]->(b:Entity)
WHERE NOT b.orphan
RETURN a, r, b,
       [rel IN relationships(path) | {
         type: type(rel),
         evidence: rel.evidence[0..2]
       }] AS relInfo
LIMIT 50
```

邻域结果转成三元组文本 + 关联 chunk 原文，作为上下文喂给 LLM 生成答案。

**每条边都带 `evidence`（原文片段）**，所以答案可以做到**逐句溯源**——这是图谱相比纯向量检索的一大优势。

### 9.3 三路召回融合

```
               查询
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
  BM25        kNN        图谱子图
kh_document  kh_chunk    Neo4j
    │           │           │
    └───────────┼───────────┘
                ▼
           RRF 融合排序          ← Reciprocal Rank Fusion，无需调权重
                ▼
         Top-K → LLM 生成
```

RRF 公式简单且无需标注数据调权重：

```
score(d) = Σ_over_检索器  1 / (k + rank_i(d)),  k 取 60
```

### 9.4 Global Search（P6，暂不做）

对图做社区检测（Leiden）+ LLM 生成社区摘要，回答「我们技术栈整体有什么风险」这类全局问题。需要额外引入图算法（Neo4j GDS 插件，当前 compose 只装了 APOC）。

---

## 10. 配置与成本控制

### 环境变量

```bash
# Neo4j
NEO4J_ENABLED=true
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=12345678

# LLM 抽取（可与 embedding 共用 DashScope key）
KG_LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
KG_LLM_MODEL=qwen-plus
KG_LLM_API_KEY=<your-api-key>

# 抽取行为
KG_EXTRACT_CONCURRENCY=4      # 并发上限，别打满服务商限流
KG_PROMPT_VERSION=v1          # 改 prompt / 本体必须递增，否则缓存不失效
KG_MAX_RETRY=2
KG_ENTITY_SIM_THRESHOLD=0.85  # L3 消歧候选阈值
```

三个开关（`RUSTFS_ENABLED` / `RABBITMQ_ENABLED` / `ELASTICSEARCH_ENABLED` / `NEO4J_ENABLED`）统一置 `false` 可跳过对应外部依赖，便于本地最小化启动。

### 成本控制手段

| 手段 | 说明 |
| --- | --- |
| **抽取缓存** | `kg_extraction` 按内容哈希缓存，重发/重跑不重复烧 token |
| **并发钳制** | `KG_EXTRACT_CONCURRENCY` 默认 4，DashScope 有 QPS 限制 |
| **失败不无限重试** | `KG_MAX_RETRY=2` 后进死信队列，人工排查 |
| **单块失败不阻断整篇** | 与 `PipelineOrchestrator.reindexOne` 的 per-doc try/catch 一致 |
| **温度 0** | 保证同输入同输出，缓存才有意义 |
| **空块短路** | 纯图片、纯表格块先判断可抽取性再调用 |

### 降级策略（与现有约定一致）

- Neo4j 不可用 → 记日志跳过图谱写入，**不阻断发布主流程**
- LLM 不可用 / 未配置 key → 跳过 KG 链路，RAG 与 Search 链路的链路不受影响
- 单块抽取失败 → 跳过该块，继续下一块；整篇完成后汇总告警

---

## 11. 实施路线

| 阶段 | 交付物 | 验收标准 |
| --- | --- | --- |
| **P0** | `ontology.ts` 白名单、`kg.extract.exchange/queue` 拓扑、`ChatOpenAI` 配置、`neo4j-driver` 接入 | MQ 消息能通，Neo4j 能连 |
| **P1** | `EntityExtractionService`（prompt + 三道校验 + 缓存）+ `kg_extraction` 表 | 跑 10 篇文档，**人工看抽取质量**，失败率 < 20% |
| **P2** | `GraphIndexService`（upsert / 按文档删除 / 孤儿标记） | 发布 → Neo4j Browser 能看到图；再发布不产生重复节点 |
| **P3** | `entity-resolution.service.ts`：L1+L2 全自动，L3 只**产出候选**不自动合并 | 实体数明显下降，无错误合并 |
| **P4** | `graph-query.service.ts` + `GET /graph/entities/:id/neighbors` | 前端能画出以某实体为中心的关系图 |
| **P5** | Local Search 接入 RAG 召回 + RRF 融合 | 多跳问题（"A 挂了影响谁"）能答对且带引用 |
| **P6** | 人工审核队列 + Global Search（社区摘要） | — |

### 建议的启动顺序

**P0 + P1 先做**，跑通「发布文档 → MQ → LLM 抽取 → 落 `kg_extraction`」，**先看抽取质量再决定图怎么建**。

这样风险最低：本体设计有问题、prompt 效果不好、成本超预期，都在写图之前就暴露了，改起来只是改 prompt，不涉及数据迁移。

---

## 12. 风险与已知坑

### 12.1 chunkId 不稳定，会污染抽取缓存

**现有 `ChunkingService` 的 chunkId 只跟序号有关，不跟内容有关：**

```ts
chunkId: createHash('sha256').update(`${documentId}:${chunks.length}`).digest('hex')
```

对 RAG 无所谓（整篇重建），但对 KG 是**致命**的：

| 编辑动作 | 后果 |
| --- | --- |
| 文档中段插入内容 | 后面所有 chunk 序号偏移 → chunkId 全变 |
| 文档**末尾追加**内容 | 前面的 chunk **序号和 ID 都没变，但内容变了** |

第二种情况如果拿 `chunkId` 做 LLM 抽取结果的缓存键，会**命中旧缓存写出错误的图谱**——这不是浪费 token，是**数据错误**，而且静默发生。

**规避方式**：缓存键、幂等键一律用内容哈希。

```ts
const extractKey = sha256(`${promptVersion}:${model}:${chunk.content}`);
```

（另外注意：`sha256(...).slice(0, 64)` 取满 64 位是没必要的，sha256 十六进制本身就是 64 字符——不过这不影响功能。）

### 12.2 关系边的孤儿清理

见 [8.2](#82-孤儿实体处理)。删除实体前必须检查它是否还挂着关系边，`DETACH DELETE` 会静默带走其他文档的边。

### 12.3 实体合并产生自环

见 [6. L4](#l4-人工审核)。合并互为依赖的两个实体后，`A -[:DEPENDS_ON]-> B` 会变成自环。

### 12.4 向量相似度自动合并风险

**不要做。** 0.9 相似度也可能是上下游关系而非同一实体。L3 必须经过 LLM 二判，UNCERTAIN 必须进人工队列。

### 12.5 IK 分析器

现有 `kh_document` / `kh_chunk` 的 mapping **均未指定 IK 分析器**，中文分词实际未生效（README 已知缺口）。新建 `kh_entity` 索引时务必显式配置：

```json
"analyzer": "ik_max_word", "search_analyzer": "ik_smart"
```

并且建议**优先级排在 KG 之前**把已有两个索引的 mapping 补上——实体链接依赖中文检索质量，这是前置能力。

### 12.6 顺序依赖：检索接口应排在 KG 之前

README 待办里「检索查询接口」「向量检索 / 混合检索」排在 KG 之前是有道理的，不只是先易后难：

1. **实体消歧 L3 依赖向量检索能力**（现在 `kh_chunk` 是只写不读）
2. **实体链接本质是检索问题**（查询词 → 实体）
3. **没有检索接口就验证不了 KG 效果**——无法回答「这次抽取比上次好多少」

建议：先把 ES 检索 API + 混合检索补齐，再启动 KG 的 P0。

### 12.7 其他

| 风险 | 说明 | 应对 |
| --- | --- | --- |
| LLM 幻觉 | 编造实体/关系 | 三道规则校验（5.4） |
| 本体漂移 | 多人维护各自加类型 | 本体文件走 code review |
| Neo4j 内存 | 默认堆配置偏小，大图会 OOM | `NEO4J_server_memory_heap_max__size` |
| 雪花 ID 精度 | Neo4j 的 Integer 是 64 位，但 Cypher 字面量走 JS number 会丢精度 | 全链路以 **string** 传递 ID（与现有工程约定一致） |
| 抽取结果不可复现 | temperature > 0 | 强制 `temperature: 0` |

---

## 附：与现有工程约定的一致性检查

| 约定 | 本方案的落实 |
| --- | --- |
| ID 统一雪花 ID，以 string 全链路传递 | Neo4j 的 `Entity.id` / `Document.id` / `Chunk.id` 均为 string |
| 降级优先，外部依赖不可用不阻断主流程 | Neo4j / LLM 不可用时跳过 KG 链路，只记日志 |
| 一次发布全链路共享 traceId | KG 消息体带 `traceId`，与 `ReindexMessage` 一致 |
| MQ 投递失败只记日志、不回滚发布状态 | 沿用 `DocumentPipelinePublisher` 现有行为 |
| 分层：生产者 / 消费者 / 编排器 / 具体 service | `KgConsumer` → `PipelineOrchestrator.handleKgExtract` → `EntityExtractionService` + `GraphIndexService` |
| 队列名带 `kh.` 前缀 | `kh.kg.extract.queue` |
