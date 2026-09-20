import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * 邮箱激活请求（GET query）。
 *
 * 必须走 DTO 而不是 `@Query('token') token: string`：全局 ValidationPipe 只对 DTO 类生效，
 * 裸参数完全不过校验，任何人都能塞一个 10MB 的 token 进来。
 *
 * 另注意 `forbidNonWhitelisted: true` 对 query 同样生效 ——
 * 邮件里的链接**不要**附带 utm_* 之类的跟踪参数，否则会被直接 400。
 */
export class VerifyEmailDto {
  /** 邮件链接里带的一次性激活 token（base64url，43 字符） */
  @IsString()
  @IsNotEmpty({ message: '缺少激活 token' })
  @MaxLength(512)
  token: string;
}
