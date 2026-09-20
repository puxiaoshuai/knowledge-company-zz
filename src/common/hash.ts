import { createHash } from 'crypto';

/**
 * 字符串 → SHA-256 hex（64 字符）。
 *
 * 用于把「一次性的凭据原文」转成可以安全落库 / 落 Redis 的指纹：
 * 刷新令牌（kh_refresh_token.token_hash）、邮箱激活 token、找回密码验证码，
 * 以及密码重置那几个以用户名为 key 的 Redis key，都只存哈希 ——
 * 这样即使库或缓存的快照被读走，也无法反推出可以直接使用的原文
 * （key 那一处还顺带避免把用户名明文摊在无认证的 RedisInsight 里）。
 *
 * 注意哈希不可逆：存了哈希就没法从存储侧反查回原文，
 * 调试时需要由签发方在日志里留下原文（见 MailService 的降级日志）。
 *
 * 也注意「哈希 ≠ 强度」：对 6 位数字验证码这类低熵输入，离线枚举 10^6 次即可还原，
 * 那一处的哈希只是为了统一约定、避免 dump 被肉眼直读；真正起作用的是
 * 有效期与试错次数上限（见 PasswordResetService）。
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
