-- 给 kh_user 增加 email_verified（邮箱激活标记），并给 email 加未删除唯一索引
--
-- 背景：注册流程从「注册即启用」改为「注册 → 收激活邮件 → 点链接激活 → 才能登录」。
-- email_verified = 0 的账号密码即使正确也拒绝登录（403）。
--
-- 本文件不随 docker-compose 自动执行：init-scripts/postgresql/ 整个目录被挂载到
-- /docker-entrypoint-initdb.d，而该目录下的**子目录**会被入口脚本忽略。
-- 全新初始化由 init.sql 直接建好该列，只有已存在的库才需要手工执行本脚本。
--
-- 执行方式：
--   docker exec -i knowledge_hub_postgres psql -U user -d knowledge_hub < init-scripts/postgresql/migrations/20260920-add-user-email-verified.sql
--
-- 执行前若库里已有重复的非空 email，末尾的 CREATE INDEX 会报唯一冲突，先查：
--   SELECT email, COUNT(*) FROM kh_user WHERE deleted = false AND email IS NOT NULL
--   GROUP BY email HAVING COUNT(*) > 1;

DO $$
BEGIN
    -- 「加列 + 放行存量账号」必须整体只发生一次。
    -- 不能写成 ADD COLUMN IF NOT EXISTS 配一条无条件的 UPDATE：那样第二次执行会把
    -- 「本次改动之后新注册、故意留成未验证」的账号一并标成已验证，等于把激活流程静默关掉。
    -- 包在同一个 IF 里，语义才是「只发生一次的历史迁移」。
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'kh_user' AND column_name = 'email_verified'
    ) THEN
        ALTER TABLE kh_user
            ADD COLUMN email_verified SMALLINT NOT NULL DEFAULT 0;

        COMMENT ON COLUMN kh_user.email_verified IS '邮箱是否已验证：0 未验证 1 已验证（0 时禁止登录）';

        -- 存量账号都是在「注册即可用」时期建的，那时没有验证概念，它们的邮箱从未被验证过，
        -- 但也无从验证（没有待激活的 token）。统一放行，否则本次上线后所有老用户立刻登录不了。
        UPDATE kh_user SET email_verified = 1;
    END IF;
END $$;

-- 未删除邮箱唯一。必须带 deleted = false，否则软删除用户的邮箱会被永久锁死、谁都注册不了。
-- 幂等，可重复执行。
CREATE UNIQUE INDEX IF NOT EXISTS uk_kh_user_email
    ON kh_user(email) WHERE deleted = false AND email IS NOT NULL;
