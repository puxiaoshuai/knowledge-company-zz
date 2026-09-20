import { IsNotEmpty, IsString } from 'class-validator';

/** 刷新令牌请求 */
export class RefreshTokenDto {
  /** 登录 / 刷新时返回的 refreshToken */
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}
