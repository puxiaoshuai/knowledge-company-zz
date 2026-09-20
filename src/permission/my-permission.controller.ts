import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type.js';
import { PermissionResolverService } from './permission-resolver.service.js';

/**
 * 当前登录用户的权限视图：GET /permissions/me。
 *
 * 刻意独立成控制器而不是塞进 PermissionController：那边的类级
 * @Roles(RoleCode.Admin) 会把 /me 也拦掉，而「看自己的权限」只需要登录。
 * 用方法级空 @Roles() 覆盖类级标注虽然技术上可行，但「空装饰器表示放开」
 * 太隐晦，两个控制器共用同一 @Controller 前缀的写法一眼能看懂。
 */
@Controller('permissions')
export class MyPermissionController {
  constructor(private readonly resolver: PermissionResolverService) {}

  /**
   * 我的权限码集合 + 菜单树。
   * codes 供前端按钮显隐（v-permission），menus 供动态路由；
   * 管理员返回全量启用权限（admin 角色隐式持有全部权限码）。
   */
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.resolver.getMyPermissions(user.id, user.roles);
  }
}
