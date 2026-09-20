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

/** 降级日志的固定前缀，方便 grep 一次性捞出所有找回密码验证码 */
export const PASSWORD_RESET_CODE_LOG_PREFIX = 'PASSWORD_RESET_CODE';

/** 从任意异常里取一句可读信息 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 邮件服务（nodemailer + SMTP）。
 *
 * 降级策略与 RedisService 刻意相反：**本服务永不抛错**。
 * 邮件是「可降级交付」的——SMTP 没配或发送失败时，把激活链接 / 重置验证码打到日志里，
 * 开发与内网环境照样能完成激活或改密，业务流程不该因为一封发不出去的邮件而失败。
 * 所以对外只返回 { sent, reason }，由调用方决定要不要记一笔。
 *
 * 也正因为「哈希后不可逆、无法从 Redis 反查原文」，日志是调试期唯一的凭据来源，
 * 打印降级日志不是顺手加的便利，而是这条链路的必要组成部分。
 * （重置验证码进日志的风险明显高于激活链接，理由见 sendPasswordResetCode 的注释。）
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

  /**
   * 发送找回密码验证码。
   *
   * 与 sendVerificationEmail 同样是「永不抛错 + 失败降级到日志」。
   *
   * @param ttlMinutes 有效期（分钟），由调用方从配置里读好传进来。
   *   刻意不在这里再读一次 config：激活邮件那套把「24 小时内有效」写死在正文里，
   *   改了 EMAIL_VERIFY_TOKEN_TTL_SECONDS 就会与实际有效期不符，别复制这个隐患。
   */
  async sendPasswordResetCode(
    to: string,
    code: string,
    username: string,
    ttlMinutes: number,
  ): Promise<SendMailResult> {
    // 降级通道：没有 SMTP 时验证码只能从日志里拿。
    //
    // ⚠️ 这个取舍比激活链接那套要重：激活链接进日志顶多让人帮忙点一下激活，
    // 而**重置验证码进日志等于给任何有日志读权限的人一个账号接管入口**。
    // 仍然保留它的理由：10 分钟 TTL 把窗口压得很短，且开发 / 内网环境没有 SMTP 时
    // 这是唯一能走通全流程的通道（哈希不可逆，没法从 Redis 反查回验证码）。
    // 生产环境应保证 SMTP 可用，并限制日志读取权限。
    if (!this.transporter) {
      this.logger.warn(
        `${PASSWORD_RESET_CODE_LOG_PREFIX} user=${username} to=${to} code=${code}（SMTP 未配置，验证码仅打印）`,
      );
      return { sent: false, reason: 'not-configured' };
    }

    try {
      await this.transporter.sendMail({
        from: this.from,
        to,
        subject: '重置密码验证码 — Knowledge Hub',
        text: this.buildResetText(username, code, ttlMinutes),
        html: this.buildResetHtml(username, code, ttlMinutes),
      });
      this.logger.log(`重置密码验证码已发送：user=${username} to=${to}`);
      return { sent: true, reason: 'smtp' };
    } catch (error) {
      this.logger.error(
        `重置密码验证码发送失败：user=${username} to=${to} ${reason(error)}`,
      );
      this.logger.warn(
        `${PASSWORD_RESET_CODE_LOG_PREFIX} user=${username} to=${to} code=${code}（发送失败，验证码仅打印）`,
      );
      return { sent: false, reason: 'failed' };
    }
  }

  /**
   * 验证码邮件正文**只放验证码，不放任何链接**。
   *
   * 这是与激活邮件刻意相反的设计：邮件客户端与企业网关会**预取**邮件里的链接，
   * 一旦放了「点击重置」的按钮，验证码这条链路就得重新面对「机器先于人消费凭据」的问题。
   */
  private buildResetText(
    username: string,
    code: string,
    ttlMinutes: number,
  ): string {
    return [
      `${username}，你好：`,
      '',
      `你正在重置 Knowledge Hub 的登录密码，验证码是：`,
      '',
      `    ${code}`,
      '',
      `验证码 ${ttlMinutes} 分钟内有效，请勿转发给他人。`,
      '如果这不是你本人的操作，忽略本邮件即可，你的密码不会被修改。',
    ].join('\n');
  }

  private buildResetHtml(
    username: string,
    code: string,
    ttlMinutes: number,
  ): string {
    return [
      `<p>${username}，你好：</p>`,
      '<p>你正在重置 Knowledge Hub 的登录密码，验证码是：</p>',
      // 等宽 + 字距 + 大字号：便于用户逐位核对，也避免数字被邮件客户端的
      // 自动格式化（部分客户端会把长数字识别成电话/日期）破坏
      `<p style="font-family:monospace;font-size:28px;letter-spacing:6px;font-weight:bold">${code}</p>`,
      `<p>验证码 ${ttlMinutes} 分钟内有效，请勿转发给他人。</p>`,
      '<p>如果这不是你本人的操作，忽略本邮件即可，你的密码不会被修改。</p>',
    ].join('');
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
