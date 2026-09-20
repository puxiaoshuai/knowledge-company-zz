import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { RoleCode, ROLE_STATUS_ENABLED } from './constants/role.constant.js';
import { RoleEntity } from './entities/role.entity.js';
import { EmailVerified, UserEntity } from './entities/user.entity.js';
import { UserRoleEntity } from './entities/user-role.entity.js';
import type { AuthUser } from './types/auth-user.type.js';
import type { RoleOption } from './types/role-option.type.js';
import type { TokenSubject } from './types/token-context.type.js';

/**
 * 「用户有哪些角色」与「用户对外长什么样」的共享访问器。
 *
 * 从 AuthService 抽出来独立成服务，是因为现在有两条链路都要回答这两个问题：
 * 认证链路（注册 / 登录 / 刷新 / 当前用户）与管理员链路（用户增删改查）。
 *
 * 这两件事都不是可有可无的小工具：
 * - `loadRoleCodes` 里的启用过滤是**授权谓词**（被禁用的角色不算持有）；
 * - `toAuthUser` 是「绝不展开实体」的**唯一咽喉点**，password 不外泄全靠它。
 * 复制成两份就等于把这两条不变量变成两份，日后必然分叉 ——
 * 典型后果是某天有人在用户侧顺手写了 `{ ...user }`，password 就这样漏出去。
 *
 * 放在 auth 侧而不是 user 侧，是为了保持依赖方向单向：UserModule → AuthModule。
 * 反过来放会形成 AuthModule ↔ UserModule 的循环依赖。
 */
@Injectable()
export class UserAccessorService {
  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {}

  /** 单个用户持有的启用中角色编码 */
  async loadRoleCodes(userId: string): Promise<RoleCode[]> {
    return (await this.loadRoleCodesByUserIds([userId])).get(userId) ?? [];
  }

  /**
   * 批量加载：userId → 角色编码列表。
   *
   * 用户列表按页最多 100 条，逐行调 loadRoleCodes 就是 100 次查询，
   * 所以这里一次性 IN 查回来再在内存里分组。
   *
   * 空数组必须提前返回：Postgres 的 `IN ()` 是**语法错误**，
   * 分页正好落在空页时会踩到。
   */
  async loadRoleCodesByUserIds(
    userIds: string[],
  ): Promise<Map<string, RoleCode[]>> {
    const grouped = new Map<string, RoleCode[]>();
    if (userIds.length === 0) {
      return grouped;
    }

    const rows = await this.em
      .createQueryBuilder(UserRoleEntity, 'ur')
      .innerJoin(RoleEntity, 'r', 'r.id = ur.role_id')
      .select('ur.user_id', 'userId')
      .addSelect('r.role_code', 'roleCode')
      .where('ur.user_id IN (:...userIds)', { userIds })
      .andWhere('r.status = :status', { status: ROLE_STATUS_ENABLED })
      // 固定排序，让同一批数据每次返回的角色顺序一致。
      // 原实现依赖数据库的物理返回顺序，那是没有保证的。
      .orderBy('r.role_code', 'ASC')
      .getRawMany<{ userId: string; roleCode: string }>();

    for (const row of rows) {
      // getRawMany 不走 bigintTransformer；pg 驱动默认已把 int8 解析成 string，
      // 这里显式 String() 兜底，避免日后改 pg-types 解析器时静默错位
      const userId = String(row.userId);
      const codes = grouped.get(userId);
      if (codes) {
        codes.push(row.roleCode as RoleCode);
      } else {
        grouped.set(userId, [row.roleCode as RoleCode]);
      }
    }

    return grouped;
  }

  /**
   * 启用中的角色选项，供管理端下拉框使用。
   *
   * 按 id 升序 = init.sql 的插入顺序（ADMIN / REVIEWER / USER），
   * 比按 role_code 排更贴合「管理员、审核员、普通用户」的直觉顺序。
   */
  async listEnabledRoles(): Promise<RoleOption[]> {
    const roles = await this.em.find(RoleEntity, {
      where: { status: ROLE_STATUS_ENABLED },
      order: { id: 'ASC' },
    });

    return roles.map((role) => ({
      id: role.id,
      roleCode: role.roleCode as RoleCode,
      roleName: role.roleName,
      description: role.description ?? null,
    }));
  }

  /**
   * 组装 JWT 载荷用的主体。
   *
   * name 取 realName，为空则回退到 username —— 审核记录里的 reviewerName
   * 直接用了这个值，回退保证它永远不会是空串。
   */
  toTokenSubject(user: UserEntity, roles: RoleCode[]): TokenSubject {
    return {
      id: user.id,
      username: user.username,
      name: user.realName?.trim() || user.username,
      roles,
      tokenVersion: user.tokenVersion,
    };
  }

  /**
   * 显式挑字段构造响应。
   *
   * **绝不能用 `{ ...user }`** —— 那样会把 password 哈希一起序列化出去。
   *
   * 注意这里刻意**不含 `status`**：对外暴露 0/1 会让前端去猜映射，
   * 而 `emailVerified` 已经用布尔自解释地表达了同类概念。
   * 管理端确实需要 status，由 user 模块在自己的类型上叠加（见 UserDetail）。
   */
  toAuthUser(user: UserEntity, roles: RoleCode[]): AuthUser {
    return {
      id: user.id,
      username: user.username,
      email: user.email ?? null,
      realName: user.realName ?? null,
      avatar: user.avatar ?? null,
      roles,
      emailVerified: user.emailVerified === EmailVerified.Yes,
      lastLoginAt: user.lastLoginAt ?? null,
      createdAt: user.createdAt,
    };
  }
}
