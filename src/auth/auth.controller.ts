import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { Public } from './decorators/public.decorator.js';
import { LoginDto } from './dto/login.dto.js';
import { LogoutDto } from './dto/logout.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import type { AuthenticatedUser } from './types/authenticated-user.type.js';
import type { TokenContext } from './types/token-context.type.js';

/** 从请求提取设备信息，仅用于刷新令牌的会话记录 */
function requestContext(req: Request): TokenContext {
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedIp = (
    Array.isArray(forwarded) ? forwarded[0] : forwarded
  )?.split(',')[0];

  const ip =
    forwardedIp?.trim() || req.ip || req.socket.remoteAddress || undefined;

  return {
    ip: ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

/**
 * 用户鉴权
 *
 * 登录 / 注册 / 刷新 / 登出均为 @Public()（此时还没有或不需要有效 access token），
 * profile 走全局 JwtAuthGuard，需要携带 access token。
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** 注册：创建用户并直接签发令牌，默认授予 ROLE_USER */
  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.authService.register(dto, requestContext(req));
  }

  /** 登录：返回 access + refresh 令牌 */
  @Public()
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, requestContext(req));
  }

  /** 刷新令牌：旧 refreshToken 立即失效（轮换） */
  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    return this.authService.refresh(dto.refreshToken, requestContext(req));
  }

  /** 登出：吊销 refreshToken，幂等 */
  @Public()
  @Post('logout')
  logout(@Body() dto: LogoutDto) {
    return this.authService.logout(dto);
  }

  /** 当前登录用户信息 */
  @Get('profile')
  profile(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.profile(user.id);
  }
}
