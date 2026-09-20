import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../constants/auth.constant.js';
import { TokenService } from '../token.service.js';
import type { AuthenticatedUser } from '../types/authenticated-user.type.js';

/**
 * 全局认证守卫：默认拒绝。
 *
 * 除标注 @Public() 的路由外，一律要求 `Authorization: Bearer <accessToken>`，
 * 校验通过后把用户写入 request.user 供 @CurrentUser() 与 RolesGuard 使用。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 方法级标注覆盖类级：getAllAndOverride 按 [handler, class] 顺序取第一个有值的
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();

    const token = extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('未提供访问令牌');
    }

    request.user = await this.tokenService.verifyAccessToken(token);
    return true;
  }
}

/** 从 `Authorization: Bearer <token>` 取出令牌；方案不符或令牌为空一律返回 null */
function extractBearerToken(request: Request): string | null {
  const [scheme, token] = (request.headers.authorization ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token?.trim()) {
    return null;
  }
  return token.trim();
}
