import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** 登出请求 */
export class LogoutDto {
  /** 待吊销的 refreshToken */
  @IsString()
  @IsNotEmpty()
  refreshToken: string;

  /** 为 true 时吊销该用户全部刷新令牌（登出所有设备），默认只登出当前设备 */
  @IsOptional()
  @IsBoolean()
  allDevices?: boolean;
}
