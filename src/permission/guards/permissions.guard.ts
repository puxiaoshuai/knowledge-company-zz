import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  IS_PUBLIC_KEY,
  REQUIRE_PERMISSIONS_KEY,
} from '../../auth/constants/auth.constant.js';
import { RoleCode } from '../../auth/constants/role.constant.js';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.type.js';
import { PermissionMessage } from '../constants/permission.constant.js';
import { PermissionResolverService } from '../permission-resolver.service.js';

/**
 * 全局权限码守卫：读 @RequirePermissions() 元数据，所需权限码**全部**命中才放行。
 *
 * 注册在 JwtAuthGuard / RolesGuard 之后（第 3 个全局守卫），此时 request.user 已由
 * JwtAuthGuard 填好。未标注 @RequirePermissions 的路由直接放行，零额外查询。
 *
 * 权限实时查库（不进 JWT、不缓存），授权变更即时生效 —— 这是它存在的意义，
 * 代价是每个受保护请求多一次权限查询（记录在 README 已知缺口）。
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: PermissionResolverService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // @Public() 路由上没有 request.user，必须先短路，否则会被误判成 403
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      REQUIRE_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;
    // fail-closed：request.user 缺失说明全局守卫顺序被调坏（PermissionModule
    // 挪到了 AuthModule 之前），宁可 403 也不能静默放行
    if (!user) {
      throw new ForbiddenException(PermissionMessage.Forbidden);
    }

    // ROLE_ADMIN 隐式持有全部权限码：种子数据刻意不给 admin 角色落授权记录，
    // 「管理员」的授权面由角色本身定义，而非某份可被编辑删掉的列表
    if (user.roles.includes(RoleCode.Admin)) {
      return true;
    }

    const held = await this.resolver.loadPermissionCodes(user.id);
    // all-match（AND）：列出的权限码都要满足 —— 最小权限的保守缺省，
    // 需要 OR 语义的路由应拆成多个路由或放宽到 @Roles
    if (!required.every((code) => held.has(code))) {
      throw new ForbiddenException(PermissionMessage.Forbidden);
    }

    return true;
  }
}
