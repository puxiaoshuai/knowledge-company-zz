import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * 注册请求
 *
 * 不接受任何角色字段：新用户固定授予 ROLE_USER，
 * 多传字段会被全局 ValidationPipe 的 forbidNonWhitelisted 直接拒绝。
 */
export class RegisterDto {
  /** 登录用户名（3-50 位，仅字母 / 数字 / 下划线） */
  @IsString()
  @Matches(/^[a-zA-Z0-9_]{3,50}$/, {
    message: '用户名只能包含字母、数字、下划线，长度 3-50',
  })
  username: string;

  /** 密码（6-64 位） */
  @IsString()
  @MinLength(6, { message: '密码长度至少 6 位' })
  @MaxLength(64, { message: '密码长度最多 64 位' })
  password: string;

  /** 邮箱 */
  @IsOptional()
  @IsEmail({}, { message: '邮箱格式不正确' })
  email?: string;

  /** 真实姓名 / 显示名 */
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '姓名长度最多 50 位' })
  realName?: string;
}
