import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { TokenService } from './token.service.js';

/**
 * 用户鉴权模块
 *
 * - AuthService：注册 / 登录 / 刷新 / 登出 / 当前用户
 * - TokenService：令牌签发、校验、轮换、吊销
 *
 * 这里注册的两个 APP_GUARD 是**全局**的，顺序即执行顺序：
 * 先认证（JwtAuthGuard 填 request.user），再鉴权（RolesGuard 读角色）。
 * 默认拒绝一切未标注 @Public() 的路由。
 *
 * JwtModule 不在这里配置 secret —— access / refresh 用两个不同的密钥，
 * 由 TokenService 在每次签发时显式传入。
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [TokenService],
})
export class AuthModule {}
