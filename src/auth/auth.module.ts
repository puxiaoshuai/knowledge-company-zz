import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { PasswordResetService } from './password-reset.service.js';
import { RolesGuard } from './guards/roles.guard.js';
import { TokenService } from './token.service.js';
import { UserAccessorService } from './user-accessor.service.js';

/**
 * 用户鉴权模块
 *
 * - AuthService：注册 / 登录 / 刷新 / 登出 / 当前用户 / 修改密码
 * - TokenService：令牌签发、校验、轮换、吊销
 * - EmailVerificationService：邮箱激活 token 的签发 / 校验 / 重发 / 作废
 * - PasswordResetService：找回密码验证码的签发 / 校验（依赖 TokenService 做全量下线）
 * - UserAccessorService：角色加载与用户视图映射，供本模块与 user 模块共用
 *   （依赖的 RedisService / MailService 来自 @Global() 模块，不必在这里 imports）
 *
 * 这里注册的两个 APP_GUARD 是**全局**的，顺序即执行顺序：
 * 先认证（JwtAuthGuard 填 request.user），再鉴权（RolesGuard 读角色）。
 * 默认拒绝一切未标注 @Public() 的路由。
 *
 * JwtModule 不在这里配置 secret —— access / refresh 用两个不同的密钥，
 * 由 TokenService 在每次签发时显式传入。
 *
 * 对外的 exports 是给 user 模块（管理员用户管理）用的。依赖方向刻意保持
 * 单向 UserModule → AuthModule：把 UserAccessorService 放在这里而不是 user 侧，
 * 就是为了避免 AuthModule ↔ UserModule 的循环依赖。
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    EmailVerificationService,
    PasswordResetService,
    UserAccessorService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [TokenService, EmailVerificationService, UserAccessorService],
})
export class AuthModule {}
