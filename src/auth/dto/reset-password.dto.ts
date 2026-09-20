import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * 重置密码请求。
 *
 * 全局 ValidationPipe 开了 `forbidNonWhitelisted`，多传字段（比如前端习惯带的
 * `confirmPassword`、`code` 之外的 `email`）会直接 400，不是被忽略 —— 前端别顺手多传。
 */
export class ResetPasswordDto {
  /** 注册时使用的登录用户名（与服务端签发验证码时用的写法必须完全一致） */
  @IsString()
  @IsNotEmpty({ message: '缺少用户名' })
  @MaxLength(50)
  username: string;

  /**
   * 邮件里的 6 位数字验证码。
   *
   * **必须是字符串**，不能用 `@IsNumber` / `@IsInt`：
   * - `transform: true` 下 `@IsString` 会直接拒掉 JSON 数字，
   * - 更重要的是前导零 —— `012345` 一旦被当成数字就变成 `12345`，永远校验不过。
   */
  @IsString()
  @Matches(/^\d{6}$/, { message: '验证码为 6 位数字' })
  code: string;

  /**
   * 新密码。
   *
   * 约束与 `RegisterDto.password` **逐字一致**（6-64 位、不 trim）——
   * 只要这里松一点，重置密码就成了绕过注册密码策略的后门。
   * 刻意不 trim：注册时也不 trim 密码，空格属于密码的一部分。
   */
  @IsString()
  @MinLength(6, { message: '密码长度至少 6 位' })
  @MaxLength(64, { message: '密码长度最多 64 位' })
  newPassword: string;
}
