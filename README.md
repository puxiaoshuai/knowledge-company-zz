# Knowledge Hub Backend

企业知识库后端服务。文件上传解析入库 → 文档管理 → 发布后异步构建检索索引（全文 + 向量），为后续 RAG 问答与知识图谱打底。

基于 NestJS 11 + TypeScript，元数据与正文分离存储，索引构建走 RabbitMQ 异步管线。

---

## 技术栈

| 层 | 选型 | 用途 |
| --- | --- | --- |
| 应用框架 | NestJS 11 / TypeScript 5.7 | HTTP 服务、依赖注入 |
| 关系库 | PostgreSQL 16（pgvector 镜像）+ TypeORM 0.3 | 文档元数据、业务结构化数据 |
| 文档库 | MongoDB 7 + Mongoose | Markdown 正文等非结构化数据 |
| 消息队列 | RabbitMQ 3.13 | 发布后索引构建的异步解耦 |
| 搜索引擎 | Elasticsearch 8.17 + IK 分词 | 全文索引 `kh_document` / 向量索引 `kh_chunk` |
| 对象存储 | RustFS（S3 兼容） | 原文件、PDF 抽取图片 |
| 分块 / 向量化 | LangChain（textsplitters + openai） | Markdown 感知分块、DashScope 兼容 Embedding |

---

## 架构

```
                          ┌───────────────────────────────┐
   HTTP  ────────────────▶│  DocumentController /documents│
                          └───────────────┬───────────────┘
                                          │
                          ┌───────────────▼───────────────┐
                          │         DocumentService        │
                          │  上传解析 / CRUD / 发布编排      │
                          └──┬──────────┬──────────┬───────┘
                             │          │          │
                  ┌──────────▼──┐  ┌────▼─────┐  ┌─▼─────────────┐
                  │  PostgreSQL │  │ MongoDB  │  │   RustFS      │
                  │ kh_document │  │  正文     │  │ 原文件 / 图片  │
                  └─────────────┘  └──────────┘  └───────────────┘
                                          │
                           发布 @Put /:id/publish
                                          │
                          ┌───────────────▼───────────────┐
                          │  DocumentPipelinePublisher     │  ← 投递失败只记日志，不回滚发布状态
                          └───┬───────────────────────┬───┘
                              │ RAG 重建               │ Search 重建
                  ┌───────────▼──────────┐  ┌─────────▼──────────┐
                  │ rag.reindex.exchange │  │ search.index.exch. │
                  └───────────┬──────────┘  └─────────┬──────────┘
                              │                       │
                  ┌───────────▼──────────┐  ┌─────────▼──────────┐
                  │  PipelineOrchestrator│  │ SearchIndexService │
                  │  分块 → Embedding     │  │ 文档快照直写        │
                  │  VectorIndexService  │  └─────────┬──────────┘
                  └───────────┬──────────┘            │
                              │                       │
                  ┌───────────▼──────────┐  ┌─────────▼──────────┐
                  │ ES kh_chunk          │  │ ES kh_document     │
                  │ dense_vector 多块     │  │ 整篇全文索引        │
                  └──────────────────────┘  └────────────────────┘
```

### 数据存储分工

| 存储 | 内容 | 关联键 |
| --- | --- | --- |
| PostgreSQL `kh_document` | 文档元数据（标题、摘要、分类、作者、状态、统计计数…） | `id`（雪花 ID） |
| MongoDB `document_content` | Markdown 正文、正文字数、预览摘要、版本号 | Postgres `content_id` ↔ Mongo `_id` |
| RustFS | 上传原文件、PDF 抽取的图片 | 返回可访问 URL 存于文档字段 |
| ES `kh_document` | 文档级全文检索索引 | `_id` = 文档 ID |
| ES `kh_chunk` | 分块级向量索引（dense_vector, cosine） | `_id` = chunkId，字段 `document_id` |

---

## 核心链路

### 1. 上传解析（`POST /documents/upload/parse`）

支持 `pdf` / `docx` / `xlsx` / `pptx` / `txt` / `md`，统一产出 Markdown：

- **pdf** — `pdf-parse` 抽文本与表格；对象存储可用时抽取内嵌图片上传 RustFS，按页以 Markdown 图片语法插入
- **docx** — `mammoth` → HTML，`turndown`(+GFM) → Markdown；styleMap 同时覆盖中英文 Word 内置标题样式
- **xlsx** — `exceljs` 逐 Sheet 转 Markdown 表格；失败降级 `officeparser`
- **pptx** — 自研 ZIP/XML 路径按幻灯片输出；失败降级 `officeparser`
- **txt / md** — 按 BOM → 严格 UTF-8 → GB18030 顺序推断编码解码，避免中文乱码

解析结果创建为**草稿**文档，同时把原文件上传 RustFS。上传限制单文件 50MB。

### 2. 文档管理（`/documents`）

元数据落 Postgres、正文落 Mongo，创建时先写 Mongo 拿 `_id`、再写 Postgres，**Postgres 写入失败会回滚删除已写入的正文**。删除为软删除，两侧同步置 `deleted=true`。

### 3. 发布后异步管线（`PUT /documents/:id/publish`）

发布即投递 MQ，两条链路并行：

| 链路 | Exchange / RoutingKey | 处理 | 落库 |
| --- | --- | --- | --- |
| RAG 重建 | `rag.reindex.exchange` / `rag.reindex.by_ids` | 清旧块 → Markdown 感知分块 → 批量 Embedding | ES `kh_chunk` |
| 向量清理 | `rag.reindex.exchange` / `rag.reindex.delete` | 按 `document_id` 删除全部块 | ES `kh_chunk` |
| 全文索引 | `search.index.exchange` / `search.index.document` | 消息自带文档快照，直接写入 | ES `kh_document` |
| 索引清理 | `search.index.exchange` / `search.index.delete` | 按文档 ID 删除 | ES `kh_document` |

**分块策略**：LangChain `RecursiveCharacterTextSplitter`，分隔符在 markdown 内置集合前补 `\n# ` 以支持一级标题切分；默认 `512 token / 64 token overlap`，按 `1 token ≈ 2 字符` 换算。块内首个 ATX 标题作为 `heading`，跨块继承并在无标题的后续块前缀补全，保证召回时带上下文。

**Embedding**：走 OpenAI 兼容接口（默认 DashScope `text-embedding-v3`，1024 维），批大小钳制在 10 以内（DashScope 单次上限）。向量维度必须与 `kh_chunk.embedding.dims` 一致。

**可靠性约定**：MQ 投递失败只记日志、**不回滚已发布状态**；ES 不可用时跳过索引写入并告警，不阻断主流程。一次发布全链路共享同一个 `traceId`，grep 即可还原完整路径。

---

## 当前进度

### ✅ 已完成

- [x] 基础设施编排（`docker-compose.yml`）：Postgres(pgvector) / pgAdmin / MongoDB / mongo-express / RabbitMQ / ES(+IK) / Kibana / RustFS
- [x] 文档 CRUD、分页查询、多条件筛选、软删除
- [x] 文件上传解析为 Markdown（pdf / docx / xlsx / pptx / txt / md），中文编码还原
- [x] 原文件与 PDF 抽取图片上传 RustFS
- [x] 发布 → RabbitMQ 异步管线编排（生产者 / 消费者 / 编排器分层）
- [x] 分块 + 向量化 → ES `kh_chunk`（dense_vector, cosine）
- [x] 文档快照 → ES `kh_document` 全文索引（**仅写入侧**）
- [x] 删除 / 下架时同步清理两侧 ES 索引
- [x] 雪花 ID 生成、BIGINT 序列化转换、traceId 链路日志

### 🚧 待办

- [ ] **检索查询接口**：目前 ES 只有写入侧，尚无检索 API（见下方「已知缺口」）
- [ ] 向量检索 / 混合检索（kNN、BM25 + kNN 融合排序）
- [ ] 分块实体关系抽取，构建知识图谱
- [ ] RAG 问答链路（召回 + LLM 生成 + 引用溯源）
- [ ] 用户 / 鉴权 / 权限体系
- [ ] 单元测试与 e2e 测试（当前仅脚手架自带的 1 个 spec）

### ⚠️ 已知缺口

- **全文搜索目前只有索引写入，没有查询接口**。`SearchIndexService` 仅提供 `indexDocument` / `deleteDocument`，`kh_document` 写入后尚未被任何接口读取。
- `kh_document` 与 `kh_chunk` 的 mapping 均**未指定 IK 分析器**（`content`/`title` 使用默认 `standard`）。IK 插件已内置到 ES 镜像，但中文分词效果要在 mapping 里显式配置 `analyzer: ik_max_word` / `search_analyzer: ik_smart` 才能生效。
- 向量块同样**只写不读**，尚无 kNN 检索入口。

---

## 快速开始

### 1. 启动基础设施

```bash
docker compose up -d
```

| 服务 | 地址 | 凭据 |
| --- | --- | --- |
| PostgreSQL | `localhost:5432` | `user` / `123456`，库 `knowledge_hub` |
| pgAdmin | http://localhost:8088 | `admin@admin.com` / `admin` |
| MongoDB | `localhost:27017` | `mongo_user` / `mongo_pass123` |
| mongo-express | http://localhost:8081 | `me_admin` / `me_123456` |
| RabbitMQ | `localhost:5672` / UI http://localhost:15672 | `guest` / `guest` |
| Elasticsearch | http://localhost:9200 | 无认证 |
| Kibana | http://localhost:5601 | — |
| RustFS | API `localhost:9000` / Console http://localhost:9011 | `rustfsadmin` / `rustfsadmin` |

> `kh_document` 表由 `init-scripts/postgresql/init.sql` 在容器首次初始化时创建。

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并补全。除示例中已有项外，还需配置：

```bash
# RustFS
RUSTFS_ENABLED=true
RUSTFS_ENDPOINT=http://localhost:9000
RUSTFS_PUBLIC_URL=http://localhost:9000
RUSTFS_ACCESS_KEY=rustfsadmin
RUSTFS_SECRET_KEY=rustfsadmin
RUSTFS_BUCKET=knowledge-hub
RUSTFS_REGION=us-east-1

# RabbitMQ
RABBITMQ_ENABLED=true
RABBITMQ_URL=amqp://guest:guest@localhost:5672

# RAG 分块
RAG_CHUNK_SIZE=512
RAG_CHUNK_OVERLAP=64

# Embedding（OpenAI 兼容接口）
EMBEDDING_DIMENSION=1024
EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_MODEL=text-embedding-v3
EMBEDDING_BATCH_SIZE=10
OPENAI_API_KEY=<your-api-key>          # 或 DASHSCOPE_API_KEY / EMBEDDING_API_KEY

# Elasticsearch
ELASTICSEARCH_ENABLED=true
ELASTICSEARCH_NODE=http://localhost:9200
```

> `EMBEDDING_API_KEY` / `DASHSCOPE_API_KEY` / `OPENAI_API_KEY` 三者任选其一即可。
> 三个开关（`RUSTFS_ENABLED` / `RABBITMQ_ENABLED` / `ELASTICSEARCH_ENABLED`）置 `false` 可跳过对应外部依赖，便于本地最小化启动。

### 3. 启动服务

```bash
pnpm install
pnpm start:dev        # 开发模式（watch）
pnpm build && pnpm start:prod   # 生产构建
```

服务默认监听 `http://localhost:3000`。

---

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/documents` | 创建文档（直接提交 Markdown 正文） |
| `POST` | `/documents/upload/parse` | 上传文件并解析为 Markdown，创建草稿（form-data 字段名 `file`） |
| `GET` | `/documents` | 分页查询文档列表（仅元数据，支持标题 / 分类 / 团队 / 作者 / 状态筛选） |
| `GET` | `/documents/:id` | 查询文档详情（含正文） |
| `PATCH` | `/documents/:id` | 更新文档 |
| `DELETE` | `/documents/:id` | 软删除文档 |
| `PUT` | `/documents/:id/publish` | 发布文档，异步触发索引构建 |

---

## 目录结构

```
src/
├── common/                     # 雪花 ID、traceId、BIGINT 序列化转换
├── document/                   # 文档领域
│   ├── dto/                    # 入参校验（DTO）
│   ├── entities/               # Postgres 实体
│   ├── schemas/                # Mongo Schema
│   ├── parser/                 # 文件 → Markdown 解析
│   │   ├── parsers/            # pdf / docx / xlsx / pptx / txt
│   │   └── utils/              # 编码推断、Markdown 表格工具
│   ├── document.controller.ts
│   ├── document.module.ts
│   └── document.service.ts
├── mq/                         # RabbitMQ 生产者 / 消费者 / 拓扑常量
├── pipeline/                   # 发布后知识管线
│   ├── chunking.service.ts     # 分块
│   ├── embedding.service.ts    # 向量化
│   ├── vector-index.service.ts # ES kh_chunk 写入
│   ├── search-index.service.ts # ES kh_document 写入
│   └── pipeline.orchestrator.ts# 管线编排
├── storage/                    # RustFS 对象存储
├── app.module.ts
└── main.ts
```

---

## 工程约定

- **ID**：统一雪花 ID，以 `string` 全链路传递（Postgres 列为 `BIGINT`，通过 transformer 转换，避免 JS `number` 精度丢失）
- **软删除**：Postgres 与 Mongo 两侧 `deleted` 同步置位，查询默认过滤
- **双写一致性**：正文先落 Mongo，再落 Postgres；Postgres 失败回滚 Mongo，反之不做补偿
- **降级优先**：外部依赖（ES / MQ / RustFS）不可用时不阻断主流程，记日志 + 告警降级
