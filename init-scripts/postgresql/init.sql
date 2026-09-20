-- 文档元数据表
CREATE TABLE IF NOT EXISTS kh_document (
    id BIGINT PRIMARY KEY,
    title VARCHAR NOT NULL,
    content_id VARCHAR NOT NULL UNIQUE,
    summary VARCHAR,
    category_id BIGINT,
    team_id BIGINT,
    author_id BIGINT,
    cover_image VARCHAR,
    tags VARCHAR,
    status SMALLINT NOT NULL DEFAULT 0,
    remark VARCHAR,
    view_count INT NOT NULL DEFAULT 0,
    like_count INT NOT NULL DEFAULT 0,
    comment_count INT NOT NULL DEFAULT 0,
    favourite_count INT NOT NULL DEFAULT 0,
    word_count INT NOT NULL DEFAULT 0,
    publish_time TIMESTAMP,
    is_public BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    create_by BIGINT,
    update_by BIGINT,
    deleted BOOLEAN NOT NULL DEFAULT false
);

-- 文档发布审核记录
-- 一次「提交审核」一行；approve/reject 后 review_result 非空，不再出现在待办列表
CREATE TABLE IF NOT EXISTS kh_document_review (
    id BIGINT PRIMARY KEY,                          -- 审核记录 ID（雪花）
    document_id BIGINT NOT NULL,                    -- 被审文档 ID → kh_document.id
    reviewer_id BIGINT,                             -- 审核人 ID；待审时为 NULL
    reviewer_name VARCHAR,                          -- 审核人姓名
    review_result SMALLINT,                         -- NULL=待审 1=通过 2=驳回
    review_comment VARCHAR,                         -- 审核意见（驳回必填）
    before_status SMALLINT NOT NULL,                -- 提审前文档 status（0 草稿 / 1 已发布）
    reviewed_at TIMESTAMP,                          -- 审核完成时间
    created_at TIMESTAMP NOT NULL DEFAULT NOW()     -- 提交审核时间
);
-- 按文档查审核历史
CREATE INDEX IF NOT EXISTS idx_kh_document_review_document_id ON kh_document_review(document_id);
-- 待办列表：仅 review_result IS NULL 的行
CREATE INDEX IF NOT EXISTS idx_kh_document_review_pending ON kh_document_review(review_result) WHERE review_result IS NULL;

-- ==================== 用户与角色（注册后需邮箱激活才能登录） ====================

CREATE TABLE IF NOT EXISTS kh_user (
    id BIGINT PRIMARY KEY,                          -- 用户 ID（雪花）
    username VARCHAR(50) NOT NULL,                  -- 登录用户名
    password VARCHAR(255) NOT NULL,                 -- 密码（bcrypt 哈希）
    email VARCHAR(100),                             -- 邮箱。注册接口必填（激活与后续找回的唯一通道），
                                                    -- 但列保持可空：存量/后台建的账号可能没有邮箱，
                                                    -- 它们已被迁移脚本放行，不该被列约束卡住
    email_verified SMALLINT NOT NULL DEFAULT 0,     -- 邮箱是否已验证：0 未验证 1 已验证（0 时禁止登录）
    real_name VARCHAR(50),                          -- 真实姓名 / 显示名
    avatar VARCHAR(500),                            -- 头像 URL
    status SMALLINT NOT NULL DEFAULT 1,             -- 0 禁用 1 启用
    last_login_at TIMESTAMP,                        -- 最后登录时间
    token_version INT NOT NULL DEFAULT 0,           -- 令牌版本号：自增即让该用户已签发的全部 access token 立即失效
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- 创建时间
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- 更新时间
    deleted BOOLEAN NOT NULL DEFAULT false          -- 软删除标记
);
-- 未删除用户名唯一
CREATE UNIQUE INDEX IF NOT EXISTS uk_kh_user_username ON kh_user(username) WHERE deleted = false;
-- 未删除邮箱唯一。必须带 deleted = false，否则软删除用户的邮箱会被永久锁死、谁都注册不了。
-- 唯一索引大小写敏感（Alice@x.com ≠ alice@x.com），靠应用层 trim + toLowerCase 归一，
-- 不用 lower(email) 函数索引——那会让实体层的查询写法变复杂，且目前没有按邮箱查用户的路径。
CREATE UNIQUE INDEX IF NOT EXISTS uk_kh_user_email ON kh_user(email) WHERE deleted = false AND email IS NOT NULL;

CREATE TABLE IF NOT EXISTS kh_role (
    id BIGINT PRIMARY KEY,                          -- 角色 ID（雪花）
    role_name VARCHAR(50) NOT NULL,                 -- 角色名称（展示用）
    role_code VARCHAR(50) NOT NULL UNIQUE,          -- 角色编码，如 ROLE_ADMIN / ROLE_REVIEWER / ROLE_USER
    description VARCHAR(200),                     -- 角色描述
    status SMALLINT NOT NULL DEFAULT 1              -- 0 禁用 1 启用
);

CREATE TABLE IF NOT EXISTS kh_user_role (
    id BIGINT PRIMARY KEY,                          -- 关联 ID（雪花）
    user_id BIGINT NOT NULL REFERENCES kh_user(id), -- 用户 ID
    role_id BIGINT NOT NULL REFERENCES kh_role(id), -- 角色 ID
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- 分配时间
    UNIQUE (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_kh_user_role_user_id ON kh_user_role(user_id);

-- 预置角色
INSERT INTO kh_role (id, role_name, role_code, description) VALUES
    (2000000000000000001, '管理员', 'ROLE_ADMIN', '系统管理'),
    (2000000000000000002, '审核员', 'ROLE_REVIEWER', '文档审核'),
    (2000000000000000003, '普通用户', 'ROLE_USER', '默认角色')
ON CONFLICT (id) DO NOTHING;

-- 测试账号（密码均为 123456，bcrypt）
-- email_verified 必须显式写 1：不写就会落到 DEFAULT 0，db:reset 之后三个种子账号全部登录不了
INSERT INTO kh_user (id, username, password, email, email_verified, real_name, status) VALUES
    (1000000000000000001, 'admin', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', 'admin@company.com', 1, '系统管理员', 1),
    (1000000000000000002, 'reviewer', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', 'reviewer@company.com', 1, '审核员张三', 1),
    (1000000000000000003, 'user', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', 'user@company.com', 1, '普通用户李四', 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_user_role (id, user_id, role_id) VALUES
    (3000000000000000001, 1000000000000000001, 2000000000000000001),  -- admin → 管理员
    (3000000000000000002, 1000000000000000001, 2000000000000000002),  -- admin → 审核员
    (3000000000000000003, 1000000000000000002, 2000000000000000002),  -- reviewer → 审核员
    (3000000000000000004, 1000000000000000003, 2000000000000000003)   -- user → 普通用户
ON CONFLICT (id) DO NOTHING;

-- ==================== 刷新令牌（落库；只存哈希，不存原文） ====================
-- 刻意不搬进 Redis：刷新令牌要能列出会话、按用户批量吊销、追溯轮换链（replaced_by_id），
-- 且必须比缓存活得久——Redis 一次 FLUSH 就等于全员掉线。邮箱激活 token 则是短时、一次性的，
-- 适合放 Redis（见 src/auth/email-verification.service.ts）。

CREATE TABLE IF NOT EXISTS kh_refresh_token (
    id BIGINT PRIMARY KEY,                          -- 令牌记录 ID（雪花）
    user_id BIGINT NOT NULL REFERENCES kh_user(id), -- 归属用户 ID
    token_hash VARCHAR(64) NOT NULL UNIQUE,         -- 刷新令牌原文的 SHA-256 hex
    expires_at TIMESTAMP NOT NULL,                  -- 过期时间
    revoked BOOLEAN NOT NULL DEFAULT false,         -- 是否已失效（轮换 / 登出 / 复用检测）
    revoked_at TIMESTAMP,                           -- 失效时间
    replaced_by_id BIGINT,                          -- 轮换后接替的令牌 ID，便于追溯
    user_agent VARCHAR(500),                        -- 登录设备 UA
    ip VARCHAR(64),                                 -- 登录 IP
    created_at TIMESTAMP NOT NULL DEFAULT NOW()     -- 签发时间
);
CREATE INDEX IF NOT EXISTS idx_kh_refresh_token_user_id ON kh_refresh_token(user_id);
-- 会话列表 / 批量吊销只关心未失效的行
CREATE INDEX IF NOT EXISTS idx_kh_refresh_token_active ON kh_refresh_token(user_id) WHERE revoked = false;
