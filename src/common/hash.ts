import { createHash } from 'crypto';

/**
 * 字符串 → SHA-256 hex（64 字符）。
 *
 * 用于把「一次性的凭据原文」转成可以安全落库 / 落 Redis 的指纹：
 * 刷新令牌（kh_refresh_token.token_hash）与邮箱激活 token 都只存哈希，
 * 这样即使库或缓存的快照被读走，也无法反推出可以直接使用的原文。
 *
 * 注意哈希不可逆：存了哈希就没法从存储侧反查回原文，
 * 调试时需要由签发方在日志里留下原文（见 MailService 的降级日志）。
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
