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
| Redis `kh:email-verify:*` | 邮箱激活 token（哈希）、重发冷却 | key 里带 `userId` / `tokenHash`；**短时状态，丢了重新发一封邮件即可** |

> 刷新令牌**故意不搬进 Redis**：它要能列出会话、按用户批量吊销、追溯轮换链，且必须比缓存活得久 —— 一次 `FLUSH` 就等于全员掉线。Redis 只放「短时、一次性、丢了可重建」的东西。

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
| `PATCH /users/:id` 改 `status` / 角色 / 邮箱验证状态 | 吊销该用户全部 | **立即失效**（版本号 +1） |
| `DELETE /users/:id`（软删） | 吊销该用户全部 | **立即失效**（版本号 +1） |
| `POST /auth/change-password` | 吊销该用户全部 | **立即失效**（版本号 +1） |
| 改库 `status = 0` | 不变 | **立即失效**（每次比对状态） |
| 改库 `token_version = token_version + 1` | 不变 | **立即失效** |
| 检出 refresh 令牌复用 | 吊销该用户全部 | **立即失效** |

> **失效粒度是「用户」而非「设备」**：一台设备登出会让该用户**其他设备**的 access token 一起被拒。但它们没被吊销 refresh 令牌，前端在 401 时用 refresh 换新令牌即可无感恢复 —— 所以**前端必须实现「401 → 用 refreshToken 换新令牌后重试」**，否则多设备体验会退化成「一处登出、处处掉线」。

> **禁用后重新启用，旧令牌会复活**（走管理接口时**已修复**）：原先禁用只比对 `status`、不动版本号，所以 `status` 改回 `1` 之后原先那枚 access token 又可用。现在 `PATCH /users/:id` 把 `status` 改为 `0` 时会一并吊销该用户全部令牌，复职必须重新登录。**手工改库仍有此问题**，需自行执行：`UPDATE kh_user SET status = 0, token_version = token_version + 1 WHERE id = ?`。

### 5. 邮箱激活（`/auth`）

注册**不再等价于登录**：`POST /auth/register` 建号（`email_verified = 0`）后发一封激活邮件，**不返回任何令牌**。用户点邮件里的链接打到 `GET /auth/verify-email?token=...`，置 `email_verified = 1` 之后才能登录；未激活时登录返回 **403**（不是 401 —— 凭据是对的，只是身份还没被确认）。

激活 token 存在 **Redis**（`kh:email-verify:*`），32 字节随机数转 base64url，**只存 SHA-256 哈希**（与刷新令牌同一约定），默认 24h。选 Redis 而不是落库或 JWT，是因为它需要「可作废、能被重发覆盖、能限流、到时自动消失」。

| 接口 | 说明 |
| --- | --- |
| `POST /auth/register` | 建号并发激活邮件。**Redis 不可用直接 503 且不建号** |
| `GET /auth/verify-email` | 激活。**幂等**，重复点击返回 `alreadyVerified: true` 而非报错 |
| `POST /auth/resend-verification` | 重发。60 秒冷却，响应恒定 |

**几个刻意的取舍：**

- **激活链接不是一次性的**。Gmail / 企业邮件网关会**预取**邮件里的链接，用掉即失效会让机器人在用户点击前消费掉 token。而本 token 的唯一能力是「把某账号标记为已验证」——幂等、不可逆、不能登录 / 改邮箱 / 解绑，重放它没有后果，所以保留到 TTL 到期更健壮。
- **重发会让旧链接立即失效**（同一用户只保留一个有效 token）。
- **重发响应恒定**、冷却先于查库执行：否则这个公开接口就成了「某用户名是否存在 / 是否已激活」的枚举器。
- **降级策略与其它依赖相反**：Redis 不可用时注册 / 激活 / 重发返回 503（宁可失败也不建僵尸号），而**登录、刷新、文档全链路完全不依赖 Redis，照常工作**。邮件则永不抛错 —— SMTP 没配或发送失败时把激活链接打到日志（搜 `EMAIL_VERIFY_LINK`），注册不该因为一封发不出去的邮件而失败。

> ⚠️ 激活 token 只存哈希、不可逆，**没法从 Redis 反查回链接**。所以「SMTP 未配置时打印链接」不是便利功能，而是调试期唯一的链接来源。

### 6. 找回密码（`/auth`）

两步：先按**用户名**发一封带 6 位数字验证码的邮件，再拿验证码 + 新密码提交。与激活链路一样**不返回令牌**；不同的是重置成功会**反向吊销该用户全部令牌**，用户必须用新密码重新登录。

| 接口 | 说明 |
| --- | --- |
| `POST /auth/forgot-password` | 发送验证码。60 秒冷却 + 每小时 5 次配额，响应恒定 |
| `POST /auth/reset-password` | 校验验证码并改密，成功后该用户全部令牌立即失效 |

验证码状态放在 **Redis**（`kh:password-reset:*`，key 一律用 `sha256(username)`）：

| key | 值 | TTL | 说明 |
| --- | --- | --- | --- |
| `code:<h>` | `sha256(验证码)` | 600s | 重发即覆盖，旧码立刻失效 |
| `attempts:<h>` | 整数 | 600s | 单码试错计数，**重发时归零** |
| `cooldown:<h>` | `1` | 60s | 抢到才允许发信 |
| `requests:<h>` | 整数 | 3600s | 小时配额，**重发不归零** |

**几个刻意的取舍：**

- **收 `username` 而不是 `email`**。收邮箱的话，任何人都能指定一个受害者邮箱反复触发发信 —— 这个接口不需要密码也不需要登录，等于开放了一个不限量的邮件轰炸入口。
- **验证码只有 6 位数字，安全性完全靠三道闸门**：单码试错 5 次 → 重发冷却 60s → **每小时最多 5 次**。第三条是关键：重发会重置试错计数，没有配额就能靠「重发一次 → 试 5 次」把总次数刷成约 7200 次/天，几个月即可在 10^6 空间里撞出验证码，还会向受害者邮箱灌进上千封邮件。加上配额后猜测速率锁死在 25 次/小时。
- **邮件正文只有验证码，没有任何链接**。有链接就得重新面对「邮件网关预取凭据」的问题（激活邮件那套为此才刻意不做一次性）。
- **验证码成功即销毁**（`GETDEL` 原子消费）。这与激活 token「成功也不删」的结论**相反**：激活 token 重放无害（幂等、不可逆、拿不到任何能力），验证码重放是**凭据替换**。
- **所有失败原因共用同一句 400**（未申请 / 已过期 / 输入错误 / 试错超限 / 并发抢先），否则接口会变成「该账号是否存在、是否绑了邮箱」的探测器。两道限流也**先于查库**执行，避免从 429 出现的时机反推。
- **重置成功顺手把 `email_verified` 置 1**。能收到验证码本身就证明了邮箱归属，与点激活链接等价；不这么做的话，「注册了但没激活」的用户重置完密码仍会撞上 403，陷入死循环。
- **先吊销会话、后改密码**。两步不在同一事务里，必须选一个失败窗口：这个方向失败是「用户被登出但密码没变」（吵闹、可重试），反方向失败则是「被盗的 refresh token 仍有效而密码已变」（静默，且正是本功能要防的场景）。

> ⚠️ 降级策略同激活链路：`MAIL_HOST` 为空时验证码会打到日志（搜 `PASSWORD_RESET_CODE`），Redis 不可用则直接 503。验证码进日志的风险**明显高于激活链接**（相当于给有日志读权限的人一个账号接管入口），保留是因为 10 分钟 TTL 窗口很短、且哈希不可逆没法从 Redis 反查 —— 生产环境应保证 SMTP 可用并限制日志读取权限。

### 7. 修改密码（`POST /auth/change-password`）

已登录状态下凭**当前密码**改自己的密码。身份取自 JWT，**不接受请求体传用户名** —— 这是它与「找回密码」的本质区别：前者证明「我持有旧密码」，后者证明「我能收到绑定邮箱的验证码」。两条链路的凭据强度、限流与生命周期都不同，因此是两套独立实现，唯一相同的只有「成功后全部下线」这个结果。

成功后该用户全部令牌立即失效、**不返回新令牌**，需用新密码重新登录一次。落库用 `em.update` 且只写 `password` 一个字段 —— `save(entity)` 会把自增前的 `token_version` 写回去，等于把刚吊销的令牌全部复活。

> 旧密码错误返回 **400** 而不是 401：本项目把 401 定义为前端「清令牌 / 走 401→refresh→重试」的信号，而这里的调用方令牌完全有效，回 401 会触发一次必然失败的刷新重试甚至循环。

### 8. 用户管理（`/users`，仅 `ROLE_ADMIN`）

控制器上统一标注 `@Roles(RoleCode.Admin)`，6 个接口：分页列表（用户名 / 邮箱模糊 + 状态 + 角色筛选）、角色选项、详情、新增、修改、软删除。软删记录在列表、详情、修改、删除里一律 404「用户不存在」，不区分「不存在」与「已删除」——后者等于把「这个用户名曾经存在」透给一个已经无权看它的管理员。

**三条贯穿全模块的取舍：**

- **改权限即下线**。角色内嵌在 JWT 载荷里而 guard 不重取，不吊销的话改角色最长 2h 才生效（降权尤其不能等）。所以角色变更、禁用、邮箱验证状态降为 `0` 都会立刻吊销该用户全部令牌 —— 等效于强制下线。代价是用户被登出，但对权限变更而言这是恰当且符合预期的。
- **保护最后一个管理员**。删除 / 禁用 / 摘掉 `ROLE_ADMIN` 前都要确认系统里还有别的启用中管理员，否则系统会**永久失去**管理能力，只能改库恢复。同时禁止删除 / 禁用 / 置为未验证**自己**（这几个操作会让响应返回时自己的令牌已死，无法撤销）。
- **改邮箱重置验证状态**。激活 token 与 `userId` 绑定、不校验邮箱值，所以改邮箱必须同时把 `email_verified` 重置为 `0` 并作废待用的激活 token，否则旧链接能把**新**邮箱直接标记为已验证。同一个请求里若还传了 `emailVerified`，以它为准。

**与注册的差别**：管理员建号直接指定密码与角色，`email_verified` 直接置 1 且**不发激活邮件** —— 这条链路没有「证明邮箱归属」的环节，verified 表达的是「管理员断言了这个地址」。代价是邮箱写错时会得到一个「已验证的错误地址」，纠正手段是改邮箱。

**不可改字段**：`username` / `password` 不在 DTO 里声明，传了会被 `forbidNonWhitelisted` 判 400。改密码走 `POST /auth/change-password`。

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
- [x] 邮箱激活（注册后发激活邮件，Redis 存 token，未激活禁止登录，支持重发与限流）
- [x] 找回密码（用户名 + 邮箱验证码重置密码，重置后全量下线旧会话）
- [x] 已登录凭旧密码改密码（`POST /auth/change-password`，成功后全量下线）
- [x] 用户管理（管理员：分页查询 / 详情 / 新增 / 修改 / 软删除 + 角色分配，含最后管理员保护）
- [x] 雪花 ID 生成、BIGINT 序列化转换、traceId 链路日志

### 🚧 待办

- [ ] **检索查询接口**：目前 ES 只有写入侧，尚无检索 API（见下方「已知缺口」）
- [ ] 向量检索 / 混合检索（kNN、BM25 + kNN 融合排序）
- [ ] 分块实体关系抽取，构建知识图谱
- [ ] RAG 问答链路（召回 + LLM 生成 + 引用溯源）
- [ ] 文档级权限：已登录用户目前可改任意文档，尚无「只能改自己的」归属校验
- [ ] 管理员重置他人密码（当前只有用户自助改密；管理员无法代改）
- [ ] 用户自助改邮箱、用户名改名（后台可改邮箱，但不支持改用户名）
- [ ] 已软删用户的查看 / 恢复（`/users` 一律不返回已删记录，恢复目前只能改库）
- [ ] `change-password` 的失败次数限流（access token 2h 内可无限次猜旧密码）
- [ ] `kh_refresh_token` 过期行清理任务
- [ ] 未激活账号清理任务（`email_verified = 0` 且长期未激活的会一直堆积）
- [ ] 单元测试与 e2e 测试（当前仅脚手架自带的 1 个 spec）

### ⚠️ 已知缺口

- **全文搜索目前只有索引写入，没有查询接口**。`SearchIndexService` 仅提供 `indexDocument` / `deleteDocument`，`kh_document` 写入后尚未被任何接口读取。
- `kh_document` 与 `kh_chunk` 的 mapping 均**未指定 IK 分析器**（`content`/`title` 使用默认 `standard`）。IK 插件已内置到 ES 镜像，但中文分词效果要在 mapping 里显式配置 `analyzer: ik_max_word` / `search_analyzer: ik_smart` 才能生效。
- 向量块同样**只写不读**，尚无 kNN 检索入口。
- **角色变更最长 2h 生效**（走 `PATCH /users/:id` 时不受此限）：角色内嵌在 JWT 载荷里，guard 只比对账号状态与令牌版本号、**不重取角色**；用户刷新令牌时会重新取最新角色，可提前生效。管理接口改角色后会立刻吊销该用户全部令牌，因此等效于立即生效；要彻底根除得把角色移出 JWT 或单独做版本号。
- **最后一个管理员的判定不加锁**：`PATCH /users/:id` 里「还有别的启用中管理员吗」的查询与随后的写入不在同一事务、也不加行锁，两个管理员在同一瞬间互相降权时两边都可能通过检查。触发条件极窄（≥2 个管理员 + 同时降权）。根治需在事务内对管理员行集加锁。
- **后台建号的 `email_verified = 1` 是断言而非证明**：`POST /users` 不发激活邮件，管理员邮箱写错就会得到一个「已验证的错误地址」，纠正手段是改邮箱（会把验证状态重置为 0）。
- **`change-password` 无失败次数限制**：与「无登录失败次数限制」同类，access token 2h 内可无限次猜旧密码，bcrypt cost 10（约 200-300ms）不构成有效防线。
- **guard 每请求多一次主键查询**：`verifyAccessToken` 为比对 `token_version` / `status` 会查一次 `kh_user`。当前量级可忽略，若日后成为瓶颈可在该层加进程内短 TTL 缓存，代价是失效有秒级延迟。
- **未激活账号会持续堆积**：`email_verified = 0` 且再也没回来激活的账号不会被清理，需要后续加定时任务。
- **重发激活邮件只有账号级限流**：冷却按 `username` 维度（60s），同一 IP 换着用户名打仍能触发发信。真正的防线是 IP / 设备维度限流，尚未实现。
- **找回密码同样只有账号级限流**：冷却 / 小时配额都按 `username` 维度，攻击者换着用户名打不受限。另外 `forgot-password` 对「账号不存在」只做一次 Redis 写 + 一次查库，对真实账号还要多等一次 SMTP 往返 —— 响应体恒定但**耗时能区分**（现有的 `resend-verification` 有同样问题）。彻底修复需要引入 IP 维度限流与后台发信队列，本项目当前都没有。
- **改邮箱接口缺失**：将来做「改邮箱」时必须同时重置 `email_verified = 0` 并删除 `kh:email-verify:user:<id>`，否则 24h 内旧激活链接能把新邮箱直接标记为已验证。
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
| Redis | `localhost:6379` | 无密码 |
| RedisInsight | http://localhost:5540 | — |

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

# Redis（邮箱激活 token / 重发冷却）
REDIS_ENABLED=true
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=              # 留空 = 无密码

# 邮件（SMTP）。MAIL_HOST 留空 = 激活链接改打到日志，日志里搜 EMAIL_VERIFY_LINK
MAIL_ENABLED=true
MAIL_HOST=
MAIL_PORT=587
MAIL_SECURE=false            # 465 端口改 true；587 走 STARTTLS 用 false
MAIL_USER=
MAIL_PASS=                   # QQ / 163 这类邮箱填「授权码」，不是登录密码
MAIL_FROM="Knowledge Hub <no-reply@localhost>"

# 激活邮件
EMAIL_VERIFY_URL=http://localhost:3000/auth/verify-email
EMAIL_VERIFY_TOKEN_TTL_SECONDS=86400
EMAIL_VERIFY_RESEND_COOLDOWN_SECONDS=60
```

> `EMBEDDING_API_KEY` / `DASHSCOPE_API_KEY` / `OPENAI_API_KEY` 三者任选其一即可。
> 三个开关（`RUSTFS_ENABLED` / `RABBITMQ_ENABLED` / `ELASTICSEARCH_ENABLED`）置 `false` 可跳过对应外部依赖，便于本地最小化启动。
> JWT secret 生成方式：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`。留空或沿用 `.env.example` 里的占位值会导致**服务启动失败**（故意如此，避免用弱密钥上线）。
> **`MAIL_FROM` 别写成 `"显示名" <地址>`** —— dotenv 会在引号处截断、把地址丢掉，必须写成 `"显示名 <地址>"` 或只写地址。
> `EMAIL_VERIFY_URL` 是邮件链接的完整基地址（`?token=` 由代码拼）。将来有了前端激活页，把它指向前端页面即可，不必改代码。

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

除 `/` 与 `/auth/*` 的几个公开接口外，其余都要先登录拿令牌：

```bash
# 登录并取出 accessToken（测试账号 admin / reviewer / user，密码均为 123456，邮箱已验证）
AT=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"123456"}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).accessToken))')

curl http://localhost:3000/documents -H "Authorization: Bearer $AT"
```

新用户注册后**必须先激活邮箱才能登录**：

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"123456","email":"alice@company.com"}'

# 激活链接会发到邮箱；没配 SMTP 时改打在服务端日志里，搜 EMAIL_VERIFY_LINK 即可
curl "http://localhost:3000/auth/verify-email?token=<日志里的 token>"
```

---

## API 一览

> 除 `/` 与 `/auth/register|verify-email|resend-verification|forgot-password|reset-password|login|refresh|logout` 外，**所有接口都需要 `Authorization: Bearer <accessToken>`**。完整字段说明见 [`接口文档.md`](./接口文档.md)。

**鉴权**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/auth/register` | 注册，**不发令牌**，发送激活邮件，默认授予 `ROLE_USER` |
| `GET` | `/auth/verify-email` | 邮箱激活（邮件里的链接直接指向它），幂等 |
| `POST` | `/auth/resend-verification` | 重发激活邮件（60 秒冷却，响应恒定） |
| `POST` | `/auth/forgot-password` | 发送找回密码验证码（60 秒冷却 + 每小时 5 次，响应恒定） |
| `POST` | `/auth/reset-password` | 校验验证码并重置密码，成功后**全量下线**该用户令牌 |
| `POST` | `/auth/login` | 登录，返回 access + refresh 令牌。**未激活返回 403** |
| `POST` | `/auth/refresh` | 刷新令牌（轮换，旧 refresh 立即失效） |
| `POST` | `/auth/logout` | 登出，吊销 refresh 令牌（幂等） |
| `GET` | `/auth/profile` | 当前登录用户信息 |
| `POST` | `/auth/change-password` | 凭当前密码改自己的密码，成功后**全量下线**，需重新登录 |

**用户管理**（全部需要 `ROLE_ADMIN`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/users` | 分页查询用户列表（用户名 / 邮箱模糊 + 状态 + 角色筛选） |
| `GET` | `/users/roles` | 启用中的角色选项（下拉框用，返回 `{ items }` 无分页字段） |
| `GET` | `/users/:id` | 用户详情 |
| `POST` | `/users` | 新增用户（直接指定密码与角色，`email_verified` 置 1 且不发激活邮件） |
| `PATCH` | `/users/:id` | 修改用户（含启用 / 禁用、分配角色；改邮箱会重置验证状态） |
| `DELETE` | `/users/:id` | 软删除用户，并立即吊销其全部令牌 |

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

**测试账号**（密码均为 `123456`，邮箱已验证，可直接登录）：`admin`（ADMIN + REVIEWER）、`reviewer`（REVIEWER）、`user`（USER）。

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
│   ├── auth.service.ts         # 注册 / 登录 / 刷新 / 登出 / 当前用户 / 修改密码
│   ├── email-verification.service.ts # 激活 token 的签发 / 校验 / 重发 / 作废
│   ├── password-reset.service.ts     # 找回密码验证码的签发 / 校验
│   ├── token.service.ts        # 令牌签发、校验、轮换、吊销
│   ├── user-accessor.service.ts# 角色加载与用户视图映射（与 user 模块共用）
│   └── user-identity.util.ts   # 邮箱归一、唯一键冲突翻译
├── common/                     # 雪花 ID、SHA-256、traceId、BIGINT 序列化转换
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
├── mail/                       # nodemailer + SMTP（未配置时降级为打印链接）
├── mq/                         # RabbitMQ 生产者 / 消费者 / 拓扑常量
├── pipeline/                   # 发布后知识管线
│   ├── chunking.service.ts     # 分块
│   ├── embedding.service.ts    # 向量化
│   ├── vector-index.service.ts # ES kh_chunk 写入
│   ├── search-index.service.ts # ES kh_document 写入
│   └── pipeline.orchestrator.ts# 管线编排
├── redis/                      # ioredis（激活 token / 频率限制）
├── storage/                    # RustFS 对象存储
├── user/                       # 用户管理（仅管理员，依赖 auth 模块）
│   ├── constants/              # 对外文案
│   ├── dto/                    # 列表查询 / 新增 / 修改入参
│   ├── types/                  # UserDetail（AuthUser + status/updatedAt）
│   ├── user.controller.ts      # 类级 @Roles(ROLE_ADMIN)
│   ├── user.module.ts
│   └── user.service.ts         # CRUD + 安全规则 + 令牌吊销
├── app.module.ts
└── main.ts
```

---

## 工程约定

- **ID**：统一雪花 ID，以 `string` 全链路传递（Postgres 列为 `BIGINT`，通过 transformer 转换，避免 JS `number` 精度丢失）
- **软删除**：Postgres 与 Mongo 两侧 `deleted` 同步置位，查询默认过滤
- **双写一致性**：正文先落 Mongo，再落 Postgres；Postgres 失败回滚 Mongo，反之不做补偿
- **降级优先**：外部依赖（ES / MQ / RustFS）不可用时不阻断主流程，记日志 + 告警降级。**两个例外，方向刻意相反**：Redis 在「注册 / 激活 / 重发」上不可用则直接 503（宁可失败也不建出无法激活的僵尸账号），而登录 / 刷新 / 文档链路完全不依赖它；邮件则**永不抛错**，SMTP 没配就把链接打到日志
- **只存哈希**：刷新令牌与邮箱激活 token 都只存 SHA-256，不存原文（见 `src/common/hash.ts`）。代价是不可逆、无法反查，调试要靠签发方留日志
- **鉴权默认拒绝**：全局 `JwtAuthGuard` 要求所有路由携带有效 access token，用 `@Public()` 开白名单。**新增接口若忘记标注，会直接 401**
- **身份只从 JWT 取**：`authorId` / `createBy` / `updateBy` / `reviewerId` / `reviewerName` 一律由服务端从令牌解析，**不接受请求体传入**（旧字段保留仅为兼容，已停止生效）
- **绝不展开实体**：响应必须显式挑字段构造（见 `UserAccessorService.toAuthUser`），不允许 `{ ...user }`，否则 `password` 会被序列化出去。这是全仓唯一的一道关口，因此 `UserAccessorService` 由 auth 与 user 两个模块共用而不复制
- **改权限即下线**：角色 / 状态 / 邮箱验证状态的变更一律吊销该用户全部令牌（`TokenService.revokeAllForUser`，含 `token_version` 自增）。角色内嵌在 JWT 载荷里而 guard 不重取，不吊销就等于「改了最长 2h 才生效」。宁可让用户重新登录
- **保护最后的管理员**：删除 / 禁用 / 从最后一个启用中管理员身上摘掉 `ROLE_ADMIN` 前必须确认还有别人兜底，同时禁止删除 / 禁用 / 置为未验证自己 —— 否则系统会永久失去管理能力，只能改库恢复
- **写 UserEntity 只用 `em.update`**：`save(entity)` 会把读出来时的 `tokenVersion` 一并回写，覆盖掉期间自增的值，等于把刚吊销的令牌全部复活
