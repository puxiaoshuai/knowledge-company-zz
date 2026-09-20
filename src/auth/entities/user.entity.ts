import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bitint.transformer.js';

/** 用户状态：0 禁用 1 启用 */
export const UserStatus = {
  Disabled: 0,
  Enabled: 1,
} as const;

export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

/**
 * 邮箱是否已验证：0 未验证 1 已验证。
 *
 * 刻意不复用 UserStatus 表达「未验证」——`status = 0` 的登录文案是「账号已被禁用」，
 * 与「注册了但没点激活链接」是完全不同的两件事，混在一起运营侧就无法区分，
 * 也没法给用户回放正确的提示。
 */
export const EmailVerified = {
  No: 0,
  Yes: 1,
} as const;

export type EmailVerified = (typeof EmailVerified)[keyof typeof EmailVerified];

/** 用户（PostgreSQL kh_user） */
@Entity('kh_user')
export class UserEntity {
  /** 用户 ID（雪花） */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 登录用户名 */
  @Column({ type: 'varchar', length: 50 })
  username: string;

  /** 密码（bcrypt 哈希）—— 绝不允许出现在任何响应中 */
  @Column({ type: 'varchar', length: 255 })
  password: string;

  /** 邮箱 */
  @Column({ type: 'varchar', length: 100, nullable: true })
  email?: string | null;

  /**
   * 邮箱是否已验证（0 未验证 / 1 已验证）。
   *
   * 注册时固定写 EmailVerified.No，必须点完邮件里的激活链接才会变成 Yes；
   * 为 No 时禁止登录（见 AuthService.login）。存量账号由迁移脚本统一置 1。
   */
  @Column({
    name: 'email_verified',
    type: 'smallint',
    default: EmailVerified.No,
  })
  emailVerified: EmailVerified;

  /** 真实姓名 / 显示名 */
  @Column({ name: 'real_name', type: 'varchar', length: 50, nullable: true })
  realName?: string | null;

  /** 头像 URL */
  @Column({ type: 'varchar', length: 500, nullable: true })
  avatar?: string | null;

  /** 0 禁用 1 启用 */
  @Column({ type: 'smallint', default: UserStatus.Enabled })
  status: UserStatus;

  /** 最后登录时间 */
  @Column({ name: 'last_login_at', type: 'timestamp', nullable: true })
  lastLoginAt?: Date | null;

  /**
   * 令牌版本号。
   *
   * access token 无状态，签发后在过期前无法单独撤销；签发时把这个值写进令牌载荷，
   * 每次请求再比对一次库里的当前值，因此自增一次即可让该用户**全部**已签发的
   * access token 立即失效（登出 / 强制下线 / 改密码 / 刷新令牌复用）。
   */
  @Column({ name: 'token_version', type: 'int', default: 0 })
  tokenVersion: number;

  /** 创建时间 */
  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  /** 更新时间 */
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt: Date;

  /** 逻辑删除 */
  @Column({ type: 'boolean', default: false })
  deleted: boolean;
}
