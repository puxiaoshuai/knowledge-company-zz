import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../types/authenticated-user.type.js';

/**
 * 取当前登录用户。
 *
 * 值由 JwtAuthGuard 从 access token 解析后写入 request.user，
 * 因此只应出现在受保护的路由上（@Public() 路由上会是 undefined）。
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    return request.user as AuthenticatedUser;
  },
);
