import { SetMetadata } from '@nestjs/common';
import { ROLES_KEY } from '../constants/auth.constant.js';
import type { RoleCode } from '../constants/role.constant.js';

/**
 * 声明访问该路由所需的角色，命中任意一个即可通过。
 *
 * 未标注 @Roles 的路由 = 登录即可访问，不做角色限制。
 */
export const Roles = (...roles: RoleCode[]) => SetMetadata(ROLES_KEY, roles);
