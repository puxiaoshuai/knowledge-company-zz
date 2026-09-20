-- 给 kh_user 增加 token_version（令牌版本号）
--
-- 背景：access token 无状态、不落库，签发后在过期前无法单独撤销，
-- 因此「登出 / 禁用账号 / 强制下线 / 改密码」统一通过自增这个版本号即时生效。
-- 令牌载荷里带着签发时的版本号快照，请求进来时与库里比对，不一致即 401。
--
-- 本文件不随 docker-compose 自动执行：init-scripts/postgresql/ 整个目录被挂载到
-- /docker-entrypoint-initdb.d，而该目录下的**子目录**会被入口脚本忽略。
-- 全新初始化由 init.sql 直接建好该列，只有已存在的库才需要手工执行本脚本。
--
-- 执行方式：
--   docker exec -i knowledge_hub_postgres psql -U user -d knowledge_hub < init-scripts/postgresql/migrations/20260920-add-user-token-version.sql

ALTER TABLE kh_user
    ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN kh_user.token_version IS '令牌版本号：自增即让该用户已签发的全部 access token 立即失效';
