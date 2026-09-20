import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { Public } from './decorators/public.decorator.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { LogoutDto } from './dto/logout.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { ResendVerificationDto } from './dto/resend-verification.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { VerifyEmailDto } from './dto/verify-email.dto.js';
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
 * 注册 / 激活 / 重发 / 找回密码 / 重置密码 / 登录 / 刷新 / 登出均为 @Public()
 * （此时还没有或不需要有效 access token），需要携带 access token 的是 profile 与 change-password。
 *
 * 注意注册**不再签发令牌**：注册后必须点激活邮件里的链接，激活成功才能登录。
 * 「注册 / 激活 / 重发 / 找回密码 / 重置密码」这五个接口都不返回令牌；
 * 重置密码还会反向吊销该用户**全部**已签发的令牌，用户必须重新登录。
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** 注册：创建用户（未激活）并发送激活邮件，默认授予 ROLE_USER */
  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  /**
   * 邮箱激活：校验邮件里带过来的 token，把 email_verified 置 1。
   *
   * GET 带状态变更并不符合 HTTP 语义，但邮件里的链接只可能是 GET，且本操作是幂等的
   * （重复点击返回 alreadyVerified = true 而不是报错），所以这是可接受的取舍。
   *
   * 必须用 DTO 收 query：全局 ValidationPipe 只对 DTO 类生效，`@Query('token')` 裸参数
   * 完全不过校验。也因此邮件链接里**不能**附带 utm_* 之类参数，会被 forbidNonWhitelisted 挡下。
   */
  @Public()
  @Get('verify-email')
  verifyEmail(@Query() query: VerifyEmailDto) {
    return this.authService.verifyEmail(query.token);
  }

  /**
   * 重发激活邮件。
   *
   * 响应恒定（不区分账号是否存在 / 是否已激活），否则就成了「账号是否已激活」的枚举器；
   * 60 秒冷却内的重复请求返回 429。
   */
  @Public()
  @Post('resend-verification')
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.authService.resendVerification(dto.username);
  }

  /**
   * 找回密码：向该账号绑定的邮箱发送 6 位数字验证码。
   *
   * 响应恒定（不区分账号是否存在 / 已禁用 / 没绑邮箱），否则就成了账号枚举器；
   * 60 秒冷却 + 每小时 5 次配额内超限返回 429，两者都先于查库执行，
   * 因此 429 出现的时机本身也不泄漏账号是否存在。
   *
   * 邮件里**只有验证码、没有链接** —— 有链接就会重新引入邮件网关预取凭据的问题。
   */
  @Public()
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  /**
   * 重置密码：校验验证码后改密。
   *
   * 成功后该用户**全部**已签发令牌立即失效（吊销 refresh token + 自增 token_version），
   * 且不返回新令牌 —— 用户需用新密码重新登录一次。
   *
   * 所有失败分支（未申请 / 已过期 / 验证码错误 / 试错超限 / 并发抢先）都返回同一句 400，
   * 前端不要试图从文案里区分原因。
   */
  @Public()
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  /**
   * 修改密码：凭当前密码改自己的密码。
   *
   * 刻意**没有 @Public()**：身份来自 access token（@CurrentUser），
   * 不接受请求体里传用户名 —— 这是它与上面「找回密码」的本质区别：
   * 前者证明「我持有旧密码」，后者证明「我能收到绑定邮箱的验证码」。
   *
   * 成功后该用户全部已签发令牌立即失效，且不返回新令牌，需重新登录。
   */
  @Post('change-password')
  changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.authService.changePassword(user.id, dto);
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
