import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bitint.transformer.js';

/**
 * 刷新令牌（PostgreSQL kh_refresh_token）
 *
 * 只存令牌原文的 SHA-256 哈希：刷新令牌是长期凭证，落库若存明文，
 * 等同于把长期口令写进数据库，一旦泄库所有会话可被直接接管。
 */
@Entity('kh_refresh_token')
export class RefreshTokenEntity {
  /** 令牌记录 ID（雪花） */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 归属用户 ID */
  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer })
  userId: string;

  /** 刷新令牌原文的 SHA-256 hex（64 字符），不存原文 */
  @Column({ name: 'token_hash', type: 'varchar', length: 64, unique: true })
  tokenHash: string;

  /** 过期时间 */
  @Column({ name: 'expires_at', type: 'timestamp' })
  expiresAt: Date;

  /** 是否已失效（轮换 / 登出 / 复用检测） */
  @Column({ type: 'boolean', default: false })
  revoked: boolean;

  /** 失效时间 */
  @Column({ name: 'revoked_at', type: 'timestamp', nullable: true })
  revokedAt?: Date | null;

  /** 轮换后接替的令牌 ID，便于追溯会话链 */
  @Column({
    name: 'replaced_by_id',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
  })
  replacedById?: string | null;

  /** 登录设备 UA */
  @Column({ name: 'user_agent', type: 'varchar', length: 500, nullable: true })
  userAgent?: string | null;

  /** 登录 IP */
  @Column({ type: 'varchar', length: 64, nullable: true })
  ip?: string | null;

  /** 签发时间 */
  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;
}
