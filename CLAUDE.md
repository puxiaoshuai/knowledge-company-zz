# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此仓库中工作时提供指引。

## 仓库结构

单一 git 仓库（默认分支 `master`），内含两个独立的 pnpm 项目（无共享 workspace）：

- `knowledge-hub-backend/` — NestJS 11 后端 API（TypeScript）
- `knowledge-hub-frontend/` — React 19 + Vite + Ant Design 管理台

代码注释、JSDoc、文档及前端 README 均为中文，编辑已有文件时保持一致。

## 常用命令

所有命令必须在对应项目目录内执行。

### 后端（`cd knowledge-hub-backend`）

```bash
pnpm install
pnpm run start:dev        # watch 模式（nest start --watch），端口 3000
pnpm run build            # nest build
pnpm run lint             # eslint --fix
pnpm run format           # prettier --write
pnpm test                 # jest 单元测试（src/ 下 *.spec.ts）
pnpm test -- document.service   # 按名称匹配运行单个测试
pnpm run test:e2e         # 使用 test/jest-e2e.json 的 e2e 测试
```

基础设施（Postgres+pgvector、MongoDB、Redis、RabbitMQ、Elasticsearch+IK、Kibana、RustFS、Neo4j）通过 Docker 启动：

```bash
docker compose up -d      # 在 knowledge-hub-backend/ 下执行
```

启动前先把 `.env.example` 复制为 `.env`。关键配置：`EMBEDDING_API_KEY`/`DASHSCOPE_API_KEY`（Embedding——不配则降级为本地哈希向量）、`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`MODEL_NAME`（对话、意图识别与 KG 抽取用的 LLM——必填，缺失时抽取直接报错）、`MEM0_API_KEY`（对话长期记忆——不配则整体跳过）、`BOCHA_API_KEY`（联网搜索——不配时该兜底步报错提示）、RabbitMQ/ES/Neo4j/RustFS 的 `*_ENABLED` 开关（关闭的服务只打日志跳过，不会致命）、`DOCUMENT_REQUIRE_APPROVAL`（见下文）。修改 `.env` 后必须重启应用才生效。

预置账号（密码均为 `123456`）：`user`（文档与检索）、`admin`（系统管理）、`reviewer`（审核工作台）。

### 前端（`cd knowledge-hub-frontend`）

```bash
pnpm install
pnpm run dev              # Vite 端口 5173；/api 代理到 localhost:3000（去掉前缀）
pnpm run build            # tsc -b && vite build
pnpm run lint             # oxlint（不是 eslint）
```

需先启动后端。前端请求如 `/api/documents` → 后端路由 `/documents`。

## 后端架构

多存储引擎，各自职责明确：

- **PostgreSQL（TypeORM）** — 关系型元数据：文档、用户、角色/权限、团队。主键为 Snowflake ID，以 `bigint` 存储（`src/common/snowflake-id.ts` + bigint transformer）；`synchronize: false`，表结构来自 `init-scripts/postgresql/init.sql`。
- **MongoDB（Mongoose）** — 文档全文（`DocumentContent`，通过 `contentId` 关联）。
- **Elasticsearch** — 两个索引：`kh_document`（文档级全文搜索，IK 中文分词）和 `kh_chunk`（RAG 分块，含 `dense_vector` 向量）。
- **Neo4j** — 知识图谱（LLM 抽取的实体/关系）。
- **Redis** — 密码重置验证码等。
- **RustFS（S3 兼容）** — 原文件上传 / PDF 抽图。

### 文档生命周期与异步管线

状态定义在 `src/document/document-status.ts`：`Draft(0)` → `Published(1)` | `PendingReview(3)` → `Archived(2)`。发布是否需要审核由 `DOCUMENT_REQUIRE_APPROVAL` 控制（默认 `true`）。只有 Published 状态的文档进入索引。

文档发布时，`DocumentPipelinePublisher`（`src/mq/`）并行投递三条 RabbitMQ 消息（RAG 重建、Search 索引、KG 建图）；归档/下架时投递对应的三个删除消息。**MQ 投递失败只打日志，绝不回滚文档发布状态。** `DocumentPipelineConsumer` 消费后交给 `PipelineOrchestrator`（`src/pipeline/pipeline.orchestrator.ts`），由它加载 Postgres 元数据 + Mongo 正文并执行：

- **RAG**：清旧块 → 分块（`RAG_CHUNK_SIZE`/`RAG_CHUNK_OVERLAP`）→ Embedding → 写 ES `kh_chunk`
- **Search**：Postgres + Mongo → ES `kh_document`
- **KG**：分块 → LLM 抽取实体/关系（`src/pipeline/extraction.service.ts`）→ 写 Neo4j

索引是异步的——发布后要等十几秒内容才可被检索。

### RAG 查询链路

`src/ai/` 提供三层入口：`/rag/search`（纯检索）、`/ai/chat`（同步问答）和 `/ai/chat/stream`（SSE 流式，主力入口）。底层检索统一走 `HybridRetrievalService`：查询向量化 + `kh_chunk` 关键词召回 → RRF 融合（`RAG_HYBRID_TOP_K`、`RAG_RRF_C`）→ reranker 精排（DashScope `qwen3-rerank`，可选）。`/search`（`src/search/`）是 `kh_document` 上的普通文档级 ES 搜索。

`/ai/chat/stream` 是 Agentic 流程（`ai-stream.service.ts`，基于 LangChain agent tools），前端过程条逐步渲染：**意图识别**（闲聊/知识库/联网，`chat-query-rewrite.service.ts`）→ 知识库与图谱**并行检索**（图谱检索词是短实体名）→ **命中评估**，不相关则**改写查询再检索**（`agentic-retrieve.ts` 的 `retrieveUntilRelevant`）→ 仍不足时**联网搜索**兜底（`web-search.service.ts`，Bocha）→ LLM 生成带 `[n]` 引用的回答。闲聊不触发任何检索。

会话与记忆：会话/消息持久化在 Postgres（`src/ai/entities/`）；短期记忆是 Redis 热窗口（`chat-short-memory.service.ts`，故障时回落数据库）；长期记忆用 Mem0（`chat-long-memory.service.ts`，LLM 先分类本轮是否有新事实再写入，未配 `MEM0_API_KEY` 全部跳过）。

### 知识图谱查询

`src/graph/` 暴露 `/graph/overview|search|nodes|edges`，数据来自 Neo4j（文档/实体/标签节点 + RELATED_TO 边），复用 `search` 权限码并按团队 scope 过滤，供前端力导向图可视化。

### 鉴权与 RBAC

JWT（passport-jwt），access + refresh 双 token。守卫：`JwtAuthGuard`（全局）+ `PermissionsGuard`/`RolesGuard`；装饰器 `@Public()`、`@RequirePermission('code')`、`@Roles()` 在 `src/auth/decorators/`。权限码（`document:list`、`search` 等）定义在 `src/common/constants/permissions.ts`，由 init 脚本种子化到 Postgres。

### 文件解析

`src/document/parser/` — 按格式拆分的解析器（pdf、docx、pptx、xlsx、纯文本），统一由 `FileParserService` 调度，上传文件转 Markdown（turndown + GFM）。

### 参数校验

全局 `ValidationPipe` 且 `whitelist: true, forbidNonWhitelisted: true` — 客户端传的每个字段都必须在 DTO 上声明，否则请求被拒绝。

## 前端架构

- 路由在 `src/App.tsx`，两个包装组件：`Guard`（要求登录）和 `Perm code="..."`（按登录用户校验权限码）。
- `src/api/client.ts` — fetch 封装；自动附带 JWT，401 时做单飞 token 刷新（`/auth/refresh`）后重试一次。
- 页面在 `src/pages/`（`admin/` 下是用户/角色/团队/审核）。`ChatPage` 是知识问答主界面（SSE 过程条 + 引用来源）；KG 可视化用自定义 echarts `ForceGraph` 组件（`GraphPage`）。
- UI 文案为中文（Ant Design）。

## 手动 API 测试

后端根目录的 `curl-*.md` 是手工端到端测试的 curl 脚本文档（鉴权、文档状态流转、RAG 多文档检索、RBAC 等），请求体在 `test-files/`。`agentic-rag.md` 和 `chat-memory.md` 是 Agentic 问答与对话记忆的前端自测清单（含测题与期望行为）。写新接口前先查阅它们，了解真实的请求/响应结构。
