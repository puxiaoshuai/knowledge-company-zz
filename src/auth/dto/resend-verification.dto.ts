import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * 重发激活邮件请求。
 *
 * 收 username 而不是 email：若收 email，这个接口就成了「邮箱是否已注册」的公开探测器，
 * 而且任何人都能指定一个**受害者邮箱**触发发信，等于开了个不限量的邮件轰炸入口。
 * 收 username 时攻击者至少要先知道用户名（与登录接口的已知面相同，不新增泄漏）。
 */
export class ResendVerificationDto {
  /** 注册时使用的登录用户名 */
  @IsString()
  @IsNotEmpty({ message: '缺少用户名' })
  @MaxLength(50)
  username: string;
}
