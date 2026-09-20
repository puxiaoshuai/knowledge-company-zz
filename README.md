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

### 4. 鉴权与令牌失效（`/auth`）

双令牌：access（默认 2h，不落库）+ refresh（默认 7d，落 `kh_refresh_token`，只存 SHA-256）。两个 secret 必须不同 —— access 冒用 refresh 会被两处拦下（secret 不符 + 载荷 `type` 不符）。

access token 无状态、**签发后在过期前无法单独撤销**，因此「登出 / 禁用 / 强制下线」统一走 `kh_user.token_version`：签发时把当前值写进载荷，guard 每次请求与库里比对一次（主键查询，约 0.1ms）。

| 动作 | refresh 令牌 | access 令牌 |
| --- | --- | --- |
| `POST /auth/logout`（默认，单设备） | 吊销当前这条 | **立即失效**（版本号 +1） |
| `POST /auth/logout` `allDevices: true` | 吊销该用户全部 | **立即失效**（版本号 +1） |
| 改库 `status = 0` | 不变 | **立即失效**（每次比对状态） |
| 改库 `token_version = token_version + 1` | 不变 | **立即失效** |
| 检出 refresh 令牌复用 | 吊销该用户全部 | **立即失效** |

> **失效粒度是「用户」而非「设备」**：一台设备登出会让该用户**其他设备**的 access token 一起被拒。但它们没被吊销 refresh 令牌，前端在 401 时用 refresh 换新令牌即可无感恢复 —— 所以**前端必须实现「401 → 用 refreshToken 换新令牌后重试」**，否则多设备体验会退化成「一处登出、处处掉线」。

> **禁用后重新启用，旧令牌会复活**：禁用只比对 `status`、不动版本号，所以 `status` 改回 `1` 之后原先那枚 access token 又可用。若要求「重新启用必须重新登录」（如离职复职），禁用时连同自增：`UPDATE kh_user SET status = 0, token_version = token_version + 1 WHERE id = ?`。

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
- [x] 用户 / 鉴权 / 权限体系（JWT 双令牌 + 全局默认拒绝守卫 + `@Roles` 角色校验 + `token_version` 即时失效）
- [x] 雪花 ID 生成、BIGINT 序列化转换、traceId 链路日志

### 🚧 待办

- [ ] **检索查询接口**：目前 ES 只有写入侧，尚无检索 API（见下方「已知缺口」）
- [ ] 向量检索 / 混合检索（kNN、BM25 + kNN 融合排序）
- [ ] 分块实体关系抽取，构建知识图谱
- [ ] RAG 问答链路（召回 + LLM 生成 + 引用溯源）
- [ ] 文档级权限：已登录用户目前可改任意文档，尚无「只能改自己的」归属校验
- [ ] 用户管理接口（改密 / 禁用 / 分配角色），当前只能直接改库
- [ ] `kh_refresh_token` 过期行清理任务
- [ ] 单元测试与 e2e 测试（当前仅脚手架自带的 1 个 spec）

### ⚠️ 已知缺口

- **全文搜索目前只有索引写入，没有查询接口**。`SearchIndexService` 仅提供 `indexDocument` / `deleteDocument`，`kh_document` 写入后尚未被任何接口读取。
- `kh_document` 与 `kh_chunk` 的 mapping 均**未指定 IK 分析器**（`content`/`title` 使用默认 `standard`）。IK 插件已内置到 ES 镜像，但中文分词效果要在 mapping 里显式配置 `analyzer: ik_max_word` / `search_analyzer: ik_smart` 才能生效。
- 向量块同样**只写不读**，尚无 kNN 检索入口。
- **角色变更最长 2h 生效**：角色内嵌在 JWT 载荷里，guard 只比对账号状态与令牌版本号、**不重取角色**；用户刷新令牌时会重新取最新角色，可提前生效。要即时生效得把角色移出 JWT 或单独做版本号。
- **guard 每请求多一次主键查询**：`verifyAccessToken` 为比对 `token_version` / `status` 会查一次 `kh_user`。当前量级可忽略，若日后成为瓶颈可在该层加进程内短 TTL 缓存，代价是失效有秒级延迟。
- `src/app.module.ts` 读的是 `MONGO_URI`，而 `.env` 定义的是 `MONGODB_URI`，两者对不上 —— 实际一直静默使用代码里的硬编码默认值。改 Mongo 连接地址时要注意。
- `vitest.config.ts` / `vitest.config.e2e.ts` 是**失效配置**：vitest 既非项目依赖也未安装，实际测试运行器是 jest。`test/app.e2e-spec.ts` 未被 `pnpm test` 覆盖（jest `rootDir` 为 `src`），且 `test:e2e` 指向不存在的 `test/jest-e2e.json`。
- `src/app.controller.spec.ts` 用 `.js` 后缀导入（`./app.controller.js`），jest 没有配 `moduleNameMapper` 去后缀，**该 spec 当前无法运行**。

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

# JWT 鉴权（两个 secret 必须不同，否则 access 令牌可当 refresh 用）
JWT_ACCESS_SECRET=<随机 32 字节 hex>
JWT_ACCESS_EXPIRES_IN=2h
JWT_REFRESH_SECRET=<另一个随机 32 字节 hex>
JWT_REFRESH_EXPIRES_IN=7d
```

> `EMBEDDING_API_KEY` / `DASHSCOPE_API_KEY` / `OPENAI_API_KEY` 三者任选其一即可。
> 三个开关（`RUSTFS_ENABLED` / `RABBITMQ_ENABLED` / `ELASTICSEARCH_ENABLED`）置 `false` 可跳过对应外部依赖，便于本地最小化启动。
> JWT secret 生成方式：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`。留空或沿用 `.env.example` 里的占位值会导致**服务启动失败**（故意如此，避免用弱密钥上线）。

> ⚠️ **`init.sql` 只在 PostgreSQL 数据目录为空时执行一次。** 如果 `volumes/postgres` 已存在（即之前起过一次），新增的表**不会**被自动创建。手动补灌（脚本幂等，可重复执行）：
>
> ```bash
> docker exec -i knowledge_hub_postgres psql -U user -d knowledge_hub < init-scripts/postgresql/init.sql
> ```

### 3. 启动服务

```bash
pnpm install
pnpm start:dev        # 开发模式（watch）
pnpm build && pnpm start:prod   # 生产构建
```

服务默认监听 `http://localhost:3000`。

只有 `GET /` 是公开的，其余接口都要先登录拿令牌：

```bash
# 登录并取出 accessToken（测试账号 admin / reviewer / user，密码均为 123456）
AT=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"123456"}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).accessToken))')

curl http://localhost:3000/documents -H "Authorization: Bearer $AT"
```

---

## API 一览

> 除 `/` 与 `/auth/login|register|refresh|logout` 外，**所有接口都需要 `Authorization: Bearer <accessToken>`**。完整字段说明见 [`接口文档.md`](./接口文档.md)。

**鉴权**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/auth/register` | 注册，返回令牌，默认授予 `ROLE_USER` |
| `POST` | `/auth/login` | 登录，返回 access + refresh 令牌 |
| `POST` | `/auth/refresh` | 刷新令牌（轮换，旧 refresh 立即失效） |
| `POST` | `/auth/logout` | 登出，吊销 refresh 令牌（幂等） |
| `GET` | `/auth/profile` | 当前登录用户信息 |

**文档**

| 方法 | 路径 | 所需角色 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/` | 公开 | 健康检查 |
| `POST` | `/documents` | 登录 | 创建文档（直接提交 Markdown 正文） |
| `POST` | `/documents/upload/parse` | 登录 | 上传文件并解析为 Markdown，创建草稿（form-data 字段名 `file`） |
| `GET` | `/documents` | 登录 | 分页查询文档列表（仅元数据，支持标题 / 分类 / 团队 / 作者 / 状态筛选） |
| `GET` | `/documents/:id` | 登录 | 查询文档详情（含正文） |
| `PATCH` | `/documents/:id` | 登录 | 更新文档 |
| `DELETE` | `/documents/:id` | `ADMIN` | 软删除文档 |
| `PUT` | `/documents/:id/publish` | 登录 | 发布文档（开启审核时进入待审），异步触发索引构建 |
| `PUT` | `/documents/:id/archive` | `ADMIN` | 归档文档，清空索引 |
| `PUT` | `/documents/:id/save-draft` | 登录 | 下架编辑（已发布 → 草稿） |

**审核**

| 方法 | 路径 | 所需角色 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/documents/:id/reviews/submit` | 登录 | 单独提交审核 |
| `GET` | `/documents/:id/reviews/current` | 登录 | 该文档当前待审记录 |
| `GET` | `/documents/:id/reviews/history` | 登录 | 该文档审核历史 |
| `GET` | `/documents/reviews/tasks` | `ADMIN` / `REVIEWER` | 审核待办列表 |
| `GET` | `/documents/reviews/tasks/pending-count` | `ADMIN` / `REVIEWER` | 待审核数量（导航角标） |
| `POST` | `/documents/reviews/tasks/:taskId/approve` | `ADMIN` / `REVIEWER` | 审核通过 |
| `POST` | `/documents/reviews/tasks/:taskId/reject` | `ADMIN` / `REVIEWER` | 审核驳回 |

**测试账号**（密码均为 `123456`）：`admin`（ADMIN + REVIEWER）、`reviewer`（REVIEWER）、`user`（USER）。

---

## 目录结构

```
src/
├── auth/                       # 用户鉴权
│   ├── constants/              # 角色编码、元数据键
│   ├── decorators/             # @Public / @Roles / @CurrentUser
│   ├── dto/                    # 注册 / 登录 / 刷新 / 登出入参
│   ├── entities/               # kh_user / kh_role / kh_user_role / kh_refresh_token
│   ├── guards/                 # JwtAuthGuard（全局默认拒绝）、RolesGuard
│   ├── types/                  # JWT 载荷、当前用户、令牌对
│   ├── auth.controller.ts
│   ├── auth.module.ts          # 全局 APP_GUARD 在此注册
│   ├── auth.service.ts         # 注册 / 登录 / 刷新 / 登出 / 当前用户
│   └── token.service.ts        # 令牌签发、校验、轮换、吊销
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
- **鉴权默认拒绝**：全局 `JwtAuthGuard` 要求所有路由携带有效 access token，用 `@Public()` 开白名单。**新增接口若忘记标注，会直接 401**
- **身份只从 JWT 取**：`authorId` / `createBy` / `updateBy` / `reviewerId` / `reviewerName` 一律由服务端从令牌解析，**不接受请求体传入**（旧字段保留仅为兼容，已停止生效）
- **绝不展开实体**：响应必须显式挑字段构造（见 `AuthService.toAuthUser`），不允许 `{ ...user }`，否则 `password` 会被序列化出去
