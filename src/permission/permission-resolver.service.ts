import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { buildTree } from '../common/tree.util.js';
import {
  RoleCode,
  ROLE_STATUS_ENABLED,
} from '../auth/constants/role.constant.js';
import { RoleEntity } from '../auth/entities/role.entity.js';
import { UserRoleEntity } from '../auth/entities/user-role.entity.js';
import {
  PermissionEntity,
  PermissionStatus,
  PermissionType,
} from './entities/permission.entity.js';
import { RolePermissionEntity } from './entities/role-permission.entity.js';
import { UserPermissionEntity } from './entities/user-permission.entity.js';
import type {
  MenuTreeNode,
  MyPermissionsResult,
} from './types/permission.type.js';

/**
 * 「一个用户实际持有哪些权限」的唯一判定咽喉。
 *
 * 有效权限 =（用户 → **启用中**角色 → kh_role_permission）∪（kh_user_permission 直授），
 * 且权限本身必须启用且未软删 —— 三层过滤少任何一层都会出现
 * 「禁用角色仍在授权 / 软删权限仍在生效」的越权面。
 *
 * 与 UserAccessorService 同一存在理由：授权谓词只允许有一份。
 * PermissionsGuard（运行时校验）与 GET /permissions/me（前端菜单）共用这里，
 * 复制成两份后一旦分叉，就会出现「菜单里看得见、接口却 403」的灵异现场。
 *
 * 权限刻意**不进 JWT**、不做缓存：带 @RequirePermissions 的请求每次实时查一次库，
 * 换来「改授权即时生效、无需吊销令牌」—— 与角色机制（内嵌 JWT、改了要全员下线）
 * 是刻意的互补，代价与 JwtAuthGuard 每请求查 token_version 同级，
 * 已作为已知缺口记录（无缓存）。
 */
@Injectable()
export class PermissionResolverService {
  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {}

  /** 用户持有的全部有效权限码集合，PermissionsGuard 校验用 */
  async loadPermissionCodes(userId: string): Promise<Set<string>> {
    const rows = await this.grantScopeQuery(userId)
      .select('p.permission_code', 'code')
      .getRawMany<{ code: string }>();
    return new Set(rows.map((row) => row.code));
  }

  /**
   * 当前用户的权限码集合 + 菜单树（GET /permissions/me）。
   *
   * roles 含 ROLE_ADMIN 时直接给全量启用权限：admin 在守卫里是隐式全通过，
   * 种子数据也刻意不给它落 kh_role_permission 记录 —— 不特判的话
   * 管理员的前端菜单会是空的，与接口行为自相矛盾。
   *
   * codes 含全部类型的权限码（按钮显隐 / 接口元数据共用）；
   * menus 只取菜单型（permission_type = 1）建树。
   */
  async getMyPermissions(
    userId: string,
    roles: RoleCode[],
  ): Promise<MyPermissionsResult> {
    const permissions = roles.includes(RoleCode.Admin)
      ? await this.em.find(PermissionEntity, {
          where: { deleted: false, status: PermissionStatus.Enabled },
        })
      : await this.grantScopeQuery(userId).getMany();

    const codes = permissions
      .map((permission) => permission.permissionCode)
      .sort();

    // 显式给 N：回调的 children 参数与返回值都依赖 N，让 TS 自行推断会循环到 unknown
    const menus = buildTree<PermissionEntity, MenuTreeNode>(
      permissions.filter((p) => p.permissionType === PermissionType.Menu),
      (p, children) => ({
        id: p.id,
        permissionCode: p.permissionCode,
        permissionName: p.permissionName,
        menuUrl: p.menuUrl ?? null,
        icon: p.icon ?? null,
        sort: p.sort,
        children,
      }),
    );

    return { codes, menus };
  }

  /**
   * 「有效授权的权限」公共查询起点：主查 kh_permission（启用 + 未删），
   * 授权来源用两个 IN 子查询的 OR 表达，一条 SQL 完成「角色 ∪ 直授」。
   */
  private grantScopeQuery(userId: string) {
    return this.em
      .createQueryBuilder(PermissionEntity, 'p')
      .where('p.deleted = :deleted', { deleted: false })
      .andWhere('p.status = :status', { status: PermissionStatus.Enabled })
      .andWhere((qb) => {
        const viaRole = qb
          .subQuery()
          .select('rp.permission_id')
          .from(RolePermissionEntity, 'rp')
          .innerJoin(UserRoleEntity, 'ur', 'ur.role_id = rp.role_id')
          .innerJoin(RoleEntity, 'r', 'r.id = ur.role_id')
          .where('ur.user_id = :userId')
          // 禁用的角色不授权 —— 与 UserAccessorService.loadRoleCodes 的谓词同源
          .andWhere('r.status = :roleStatus', {
            roleStatus: ROLE_STATUS_ENABLED,
          })
          .getQuery();
        const direct = qb
          .subQuery()
          .select('up.permission_id')
          .from(UserPermissionEntity, 'up')
          .where('up.user_id = :userId')
          .getQuery();
        return `p.id IN (${viaRole}) OR p.id IN (${direct})`;
      })
      .setParameters({ userId });
  }
}
