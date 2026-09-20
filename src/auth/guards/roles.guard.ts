import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../constants/auth.constant.js';
import type { RoleCode } from '../constants/role.constant.js';
import type { AuthenticatedUser } from '../types/authenticated-user.type.js';

/**
 * 全局角色守卫：读 @Roles() 元数据，命中任意一个所需角色即放行。
 *
 * 注册在 JwtAuthGuard 之后，此时 request.user 已由前者填好。
 * 未标注 @Roles() 的路由不做角色限制。
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // @Public() 路由上没有 request.user，必须先短路，否则会被误判成 403
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<
      RoleCode[] | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!requiredRoles?.length) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const heldRoles = request.user?.roles ?? [];

    if (!requiredRoles.some((role) => heldRoles.includes(role))) {
      throw new ForbiddenException('无权限执行该操作');
    }

    return true;
  }
}
