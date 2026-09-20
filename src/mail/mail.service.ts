import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

/** 发送结果。sent=false 时 reason 说明原因，调用方据此决定日志级别 */
export interface SendMailResult {
  sent: boolean;
  reason: 'smtp' | 'not-configured' | 'failed';
}

/** 降级日志的固定前缀，方便 grep 一次性捞出所有激活链接 */
export const EMAIL_VERIFY_LINK_LOG_PREFIX = 'EMAIL_VERIFY_LINK';

/** 从任意异常里取一句可读信息 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 邮件服务（nodemailer + SMTP）。
 *
 * 降级策略与 RedisService 刻意相反：**本服务永不抛错**。
 * 邮件是「可降级交付」的——SMTP 没配或发送失败时，把激活链接打到日志里，
 * 开发与内网环境照样能完成激活，注册流程不该因为一封发不出去的邮件而失败。
 * 所以对外只返回 { sent, reason }，由调用方决定要不要记一笔。
 *
 * 也正因为「哈希后不可逆、无法从 Redis 反查链接」，日志是调试期唯一的链接来源，
 * 打印降级日志不是顺手加的便利，而是这条链路的必要组成部分。
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    // 发件人必须写成 `显示名 <地址@域>`，或者干脆只写地址。
    // 写成 `"显示名" <地址>`（引号只包住名字）时 dotenv 会在引号处截断，
    // 地址被静默丢掉，SMTP 收到一个没有 @ 的 From 会直接拒收。
    this.from = this.config.get<string>(
      'MAIL_FROM',
      'Knowledge Hub <no-reply@localhost>',
    );

    const enabled =
      this.config.get<string>('MAIL_ENABLED', 'true') !== 'false';
    const host = this.config.get<string>('MAIL_HOST', '').trim();

    if (!enabled) {
      this.logger.warn(
        '邮件已禁用（MAIL_ENABLED=false），激活链接将只打印到日志',
      );
      return;
    }
    if (!host) {
      this.logger.warn('MAIL_HOST 未配置，激活链接将只打印到日志');
      return;
    }

    const port = Number(this.config.get<string>('MAIL_PORT', '587'));
    const user = this.config.get<string>('MAIL_USER', '');
    const pass = this.config.get<string>('MAIL_PASS', '');

    this.transporter = nodemailer.createTransport({
      host,
      port,
      // 465 走隐式 TLS 要设 true；587 走 STARTTLS 设 false，由 nodemailer 自行升级
      secure: this.config.get<string>('MAIL_SECURE', 'false') === 'true',
      // 匿名 SMTP 中继不需要凭据，给了空串反而可能让服务器拒绝 AUTH
      auth: user ? { user, pass } : undefined,
    });

    this.logger.log(`邮件已配置：${host}:${port}（发件人 ${this.from}）`);
  }

  /**
   * 发送邮箱激活邮件。
   *
   * 无论未配置还是发送失败都**不抛错**，但都会把完整激活链接打进日志——
   * 这是用户拿回激活能力的兜底通道。
   */
  async sendVerificationEmail(
    to: string,
    link: string,
    username: string,
  ): Promise<SendMailResult> {
    if (!this.transporter) {
      this.logger.warn(
        `${EMAIL_VERIFY_LINK_LOG_PREFIX} user=${username} to=${to} link=${link}（SMTP 未配置，链接仅打印）`,
      );
      return { sent: false, reason: 'not-configured' };
    }

    try {
      await this.transporter.sendMail({
        from: this.from,
        to,
        subject: '请验证你的邮箱 — Knowledge Hub',
        text: this.buildText(username, link),
        html: this.buildHtml(username, link),
      });
      this.logger.log(`激活邮件已发送：user=${username} to=${to}`);
      return { sent: true, reason: 'smtp' };
    } catch (error) {
      // 发送失败同样把链接打出来：链接本身是有效的，用户不该因为 SMTP 抖动而卡住
      this.logger.error(
        `激活邮件发送失败：user=${username} to=${to} ${reason(error)}`,
      );
      this.logger.warn(
        `${EMAIL_VERIFY_LINK_LOG_PREFIX} user=${username} to=${to} link=${link}（发送失败，链接仅打印）`,
      );
      return { sent: false, reason: 'failed' };
    }
  }

  private buildText(username: string, link: string): string {
    return [
      `${username}，你好：`,
      '',
      '感谢注册 Knowledge Hub。请点击下面的链接完成邮箱验证，链接 24 小时内有效：',
      '',
      link,
      '',
      '如果这不是你本人的操作，忽略本邮件即可，账号不会被激活。',
    ].join('\n');
  }

  private buildHtml(username: string, link: string): string {
    // 链接用 href 包一层，同时把明文附在下方 —— 邮件客户端把链接重写成跳转页时，用户还能手动复制
    return [
      `<p>${username}，你好：</p>`,
      '<p>感谢注册 Knowledge Hub。请点击下面的按钮完成邮箱验证，链接 24 小时内有效：</p>',
      `<p><a href="${link}">验证邮箱</a></p>`,
      `<p>若按钮无法点击，请复制以下地址到浏览器打开：<br>${link}</p>`,
      '<p>如果这不是你本人的操作，忽略本邮件即可，账号不会被激活。</p>',
    ].join('');
  }
}
