import { IsNotEmpty, IsString } from 'class-validator';

/** 登录请求 */
export class LoginDto {
  /** 登录用户名 */
  @IsString()
  @IsNotEmpty()
  username: string;

  /** 密码（明文传输，由 HTTPS 保障） */
  @IsString()
  @IsNotEmpty()
  password: string;
}
