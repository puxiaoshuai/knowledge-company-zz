import { SetMetadata } from '@nestjs/common';
import { REQUIRE_PERMISSIONS_KEY } from '../constants/auth.constant.js';

/**
 * 声明访问该路由所需的权限码（kh_permission.permission_code），
 * 多个权限码须**全部**满足（AND 语义）。
 *
 * 与 @Roles 的关键差异：权限码不进 JWT，守卫每次实时查库合并
 * 「角色权限 ∪ 用户直授权限」，因此授权变更**即时生效、无需吊销令牌**
 * —— 角色内嵌 JWT、改了要全员下线，两者是刻意的互补。
 *
 * ROLE_ADMIN 对任意权限码隐式放行（种子数据刻意不给 admin 角色落授权记录）。
 * 未标注 @RequirePermissions 的路由不做权限码校验。
 */
export const RequirePermissions = (...codes: string[]) =>
  SetMetadata(REQUIRE_PERMISSIONS_KEY, codes);
