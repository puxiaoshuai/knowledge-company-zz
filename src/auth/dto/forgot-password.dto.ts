import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * 找回密码请求（发送验证码）。
 *
 * 收 username 而不是 email，与 ResendVerificationDto 同一条理由：
 * 若收邮箱，任何人都能指定一个**受害者邮箱**反复触发发信 —— 这个接口不需要密码、
 * 不需要登录，等于开了个不限量的邮件轰炸入口；而且「这个邮箱是否已注册」也会
 * 顺着接口暴露出去。收 username 时攻击者至少得先知道用户名，不新增泄漏面。
 *
 * 用户名**不做 trim / 转小写**：注册接口不归一化用户名，`uk_kh_user_username`
 * 也是大小写敏感的普通唯一索引。这里归一化的话，用户按注册时的写法提交反而查不到账号。
 */
export class ForgotPasswordDto {
  /** 注册时使用的登录用户名 */
  @IsString()
  @IsNotEmpty({ message: '缺少用户名' })
  @MaxLength(50)
  username: string;
}
