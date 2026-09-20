import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager, In } from 'typeorm';
import { ROLE_STATUS_ENABLED } from '../auth/constants/role.constant.js';
import { RoleEntity } from '../auth/entities/role.entity.js';
import { UserEntity } from '../auth/entities/user.entity.js';
import { isUniqueViolationOn } from '../auth/user-identity.util.js';
import { buildTree } from '../common/tree.util.js';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { PermissionMessage } from './constants/permission.constant.js';
import {
  PermissionEntity,
  PermissionStatus,
} from './entities/permission.entity.js';
import { RolePermissionEntity } from './entities/role-permission.entity.js';
import { UserPermissionEntity } from './entities/user-permission.entity.js';
import { CreatePermissionDto } from './dto/create-permission.dto.js';
import { QueryPermissionDto } from './dto/query-permission.dto.js';
import { UpdatePermissionDto } from './dto/update-permission.dto.js';
import type {
  AssignedPermissionIds,
  DeletePermissionResult,
  PermissionDetail,
  PermissionListResult,
  PermissionTreeNode,
} from './types/permission.type.js';

/** 发给管理员的提示：软删记录一律按不存在处理 */
const PERMISSION_NOT_FOUND = new NotFoundException(PermissionMessage.NotFound);

/** kh_permission.permission_code 的唯一约束名（Postgres 默认命名），23505 翻译用 */
const UK_PERMISSION_CODE = 'kh_permission_permission_code_key';

/**
 * 权限管理（仅管理员）：CRUD + 角色授权 + 用户直授。
 *
 * 与 user 模块同一套约定：
 *
 * 1. **软删记录一律不可见**。所有查询固定带 `deleted: false`，
 *    命中已删记录统一 404「权限不存在」。
 * 2. **不返回实体，只返回 PermissionDetail**。出参形状是 REST 契约。
 * 3. **权限变更不吊销令牌**。权限不进 JWT、守卫实时查库，改授权即时生效
 *    —— 与角色机制（内嵌 JWT、改了必须 revokeAllForUser）恰好相反，
 *    这是把权限放进 kh_role_permission 的最大收益。
 */
@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {}

  /** 全量权限树（含禁用节点，管理端勾选树用） */
  async findTree(): Promise<PermissionTreeNode[]> {
    const permissions = await this.em.find(PermissionEntity, {
      where: { deleted: false },
    });

    return buildTree<PermissionEntity, PermissionTreeNode>(
      permissions,
      (p, children) => ({
        id: p.id,
        parentId: p.parentId,
        permissionName: p.permissionName,
        permissionCode: p.permissionCode,
        permissionType: p.permissionType,
        menuUrl: p.menuUrl ?? null,
        apiUrl: p.apiUrl ?? null,
        method: p.method ?? null,
        icon: p.icon ?? null,
        sort: p.sort,
        status: p.status,
        children,
      }),
    );
  }

  /** 平铺分页（支持名称 / 编码模糊、类型 / 状态精确筛选） */
  async findAll(query: QueryPermissionDto): Promise<PermissionListResult> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const qb = this.em
      .createQueryBuilder(PermissionEntity, 'p')
      .where('p.deleted = :deleted', { deleted: false });

    if (query.permissionName) {
      qb.andWhere('p.permission_name ILIKE :permissionName', {
        permissionName: `%${query.permissionName}%`,
      });
    }
    if (query.permissionCode) {
      qb.andWhere('p.permission_code ILIKE :permissionCode', {
        permissionCode: `%${query.permissionCode}%`,
      });
    }
    if (query.permissionType !== undefined) {
      qb.andWhere('p.permission_type = :permissionType', {
        permissionType: query.permissionType,
      });
    }
    if (query.status !== undefined) {
      qb.andWhere('p.status = :status', { status: query.status });
    }

    qb.orderBy('p.sort', 'ASC').addOrderBy('p.id', 'ASC');
    qb.skip((page - 1) * pageSize).take(pageSize);

    const [permissions, total] = await qb.getManyAndCount();
    return {
      items: permissions.map((p) => this.toPermissionDetail(p)),
      total,
      page,
      pageSize,
    };
  }

  /** 新增权限。父权限须存在（未删即可，不要求启用）；编码全库唯一（含软删行） */
  async create(
    dto: CreatePermissionDto,
    actorId: string,
  ): Promise<PermissionDetail> {
    const parentId = dto.parentId ?? '0';
    if (parentId !== '0') {
      await this.assertParentExists(parentId);
    }

    // 预检刻意**不过滤 deleted**：permission_code 的唯一索引是无条件的，
    // 软删行照样占用编码，按 deleted=false 预检会漏掉这类冲突（并发漏检由索引兜底）
    if (
      await this.em.findOne(PermissionEntity, {
        where: { permissionCode: dto.permissionCode },
      })
    ) {
      throw new BadRequestException(PermissionMessage.CodeAlreadyTaken);
    }

    const permission = this.em.create(PermissionEntity, {
      id: nextSnowflakeId(),
      parentId,
      permissionName: dto.permissionName,
      permissionCode: dto.permissionCode,
      permissionType: dto.permissionType,
      menuUrl: dto.menuUrl ?? null,
      apiUrl: dto.apiUrl ?? null,
      method: dto.method ?? null,
      icon: dto.icon ?? null,
      sort: dto.sort ?? 0,
      status: dto.status ?? PermissionStatus.Enabled,
      deleted: false,
    });

    try {
      // 单表写入，不需要事务
      await this.em.insert(PermissionEntity, permission);
    } catch (error) {
      this.rethrowUniqueViolation(error);
    }

    this.logger.log(
      `权限已创建：actor=${actorId} id=${permission.id} code=${permission.permissionCode}`,
    );

    // 重读回显时间戳：@CreateDateColumn / @UpdateDateColumn 由数据库在插入时填
    return this.toPermissionDetail(
      await this.findPermissionOrThrow(permission.id),
    );
  }

  /** 修改权限（改 parentId 时防环，改 code 时查重） */
  async update(
    id: string,
    dto: UpdatePermissionDto,
    actorId: string,
  ): Promise<PermissionDetail> {
    const permission = await this.findPermissionOrThrow(id);

    if (dto.parentId !== undefined && dto.parentId !== permission.parentId) {
      // 包含「父存在」与「不成环」两个断言
      await this.assertParentAcyclic(id, dto.parentId);
    }
    if (
      dto.permissionCode !== undefined &&
      dto.permissionCode !== permission.permissionCode
    ) {
      // 与 create 同一预检口径：不过滤 deleted，但排除自己
      const taken = await this.em.findOne(PermissionEntity, {
        where: { permissionCode: dto.permissionCode },
      });
      if (taken && taken.id !== id) {
        throw new BadRequestException(PermissionMessage.CodeAlreadyTaken);
      }
    }

    const changes: Partial<PermissionEntity> = {};
    if (dto.parentId !== undefined) {
      changes.parentId = dto.parentId;
    }
    if (dto.permissionName !== undefined) {
      changes.permissionName = dto.permissionName;
    }
    if (dto.permissionCode !== undefined) {
      changes.permissionCode = dto.permissionCode;
    }
    if (dto.permissionType !== undefined) {
      changes.permissionType = dto.permissionType;
    }
    if (dto.menuUrl !== undefined) {
      changes.menuUrl = dto.menuUrl;
    }
    if (dto.apiUrl !== undefined) {
      changes.apiUrl = dto.apiUrl;
    }
    if (dto.method !== undefined) {
      changes.method = dto.method;
    }
    if (dto.icon !== undefined) {
      changes.icon = dto.icon;
    }
    if (dto.sort !== undefined) {
      changes.sort = dto.sort;
    }
    if (dto.status !== undefined) {
      changes.status = dto.status;
    }

    // em.update 传空对象会抛 UpdateValuesMissingError（全字段可选的 DTO 可能什么都不带）
    if (Object.keys(changes).length > 0) {
      try {
        await this.em.update(PermissionEntity, id, changes);
      } catch (error) {
        this.rethrowUniqueViolation(error);
      }
    }

    this.logger.log(
      `权限已更新：actor=${actorId} id=${id} fields=${Object.keys(changes).join(',') || '(无)'}`,
    );

    // 重读，让响应里的 updatedAt 反映本次写入
    return this.toPermissionDetail(await this.findPermissionOrThrow(id));
  }

  /**
   * 软删除权限。
   *
   * 有未删除子权限时拒绝（树里出现指向不存在节点的 parentId）。
   * 同事务清理 kh_role_permission / kh_user_permission 里的引用 ——
   * 注意这是**卫生措施而非安全措施**：resolver 已过滤 deleted，不清理也不会越权；
   * 清掉只是为了授权回显（GET role/:id / user/:id）不返回树上已不存在的僵尸 id。
   */
  async remove(id: string, actorId: string): Promise<DeletePermissionResult> {
    await this.findPermissionOrThrow(id);

    const childCount = await this.em.count(PermissionEntity, {
      where: { parentId: id, deleted: false },
    });
    if (childCount > 0) {
      throw new BadRequestException(PermissionMessage.HasChildren);
    }

    await this.em.transaction(async (tx) => {
      await tx.update(PermissionEntity, id, { deleted: true });
      await tx.delete(RolePermissionEntity, { permissionId: id });
      await tx.delete(UserPermissionEntity, { permissionId: id });
    });

    this.logger.log(`权限已软删：actor=${actorId} id=${id}`);

    return { id, deleted: true };
  }

  /** 角色已分配的权限 ID 列表（含指向已禁用权限的存量行，回显要如实） */
  async listRolePermissions(roleId: string): Promise<AssignedPermissionIds> {
    const role = await this.em.findOne(RoleEntity, { where: { id: roleId } });
    if (!role) {
      throw new NotFoundException(PermissionMessage.RoleNotFound);
    }

    const rows = await this.em.find(RolePermissionEntity, {
      where: { roleId },
    });
    return {
      ownerId: roleId,
      permissionIds: rows.map((row) => row.permissionId),
    };
  }

  /**
   * 整体替换角色的权限授权。
   *
   * 角色必须存在且**启用**（与 resolveRoles 的授权谓词一致：禁用角色本就不授权，
   * 往禁用角色里堆权限只会造成「重新启用那天突然多出一批授权」的惊吓）。
   * 不吊销任何用户令牌 —— 权限不进 JWT，实时查库的守卫下一请求就看到新授权面。
   */
  async assignRolePermissions(
    roleId: string,
    permissionIds: string[],
    actorId: string,
  ): Promise<AssignedPermissionIds> {
    const role = await this.em.findOne(RoleEntity, { where: { id: roleId } });
    if (!role) {
      throw new NotFoundException(PermissionMessage.RoleNotFound);
    }
    if (role.status !== ROLE_STATUS_ENABLED) {
      throw new BadRequestException(PermissionMessage.RoleDisabled);
    }

    const permissions = await this.resolvePermissions(permissionIds);

    await this.em.transaction(async (tx) => {
      // 先删后插在同一事务里，避免中间态被并发读到
      await tx.delete(RolePermissionEntity, { roleId });
      if (permissions.length > 0) {
        await tx.insert(
          RolePermissionEntity,
          permissions.map((permission) => ({
            id: nextSnowflakeId(),
            roleId,
            permissionId: permission.id,
          })),
        );
      }
    });

    this.logger.log(
      `角色授权已更新：actor=${actorId} roleId=${roleId} permissions=${permissions.length}`,
    );

    return this.listRolePermissions(roleId);
  }

  /** 用户直授的权限 ID 列表（不要求用户启用，禁用账号的管理面要如实回显） */
  async listUserPermissions(userId: string): Promise<AssignedPermissionIds> {
    await this.assertUserExists(userId);

    const rows = await this.em.find(UserPermissionEntity, {
      where: { userId },
    });
    return {
      ownerId: userId,
      permissionIds: rows.map((row) => row.permissionId),
    };
  }

  /**
   * 整体替换用户直授权限。同样不吊销令牌（理由同角色授权）。
   */
  async assignUserPermissions(
    userId: string,
    permissionIds: string[],
    actorId: string,
  ): Promise<AssignedPermissionIds> {
    await this.assertUserExists(userId);
    const permissions = await this.resolvePermissions(permissionIds);

    await this.em.transaction(async (tx) => {
      await tx.delete(UserPermissionEntity, { userId });
      if (permissions.length > 0) {
        await tx.insert(
          UserPermissionEntity,
          permissions.map((permission) => ({
            id: nextSnowflakeId(),
            userId,
            permissionId: permission.id,
          })),
        );
      }
    });

    this.logger.log(
      `用户直授权限已更新：actor=${actorId} userId=${userId} permissions=${permissions.length}`,
    );

    return this.listUserPermissions(userId);
  }

  /** 取未删除的权限，否则 404 */
  private async findPermissionOrThrow(id: string): Promise<PermissionEntity> {
    const permission = await this.em.findOne(PermissionEntity, {
      where: { id, deleted: false },
    });
    if (!permission) {
      throw PERMISSION_NOT_FOUND;
    }
    return permission;
  }

  /** 父权限须存在且未删除（不要求启用：禁用的父节点在管理端树上仍可见可挂） */
  private async assertParentExists(parentId: string): Promise<void> {
    const parent = await this.em.findOne(PermissionEntity, {
      where: { id: parentId, deleted: false },
    });
    if (!parent) {
      throw new BadRequestException(PermissionMessage.ParentNotFound);
    }
  }

  /**
   * 新父须存在，且不能是自己或自己的后代 —— 否则树断成环，
   * 前端递归渲染会栈溢出，后端组树也会死循环。
   *
   * 做法：一次取全部未删权限建 id → parentId 映射，从新父沿 parent 链上溯，
   * 途中撞见自己即有环。权限表是配置级数据（几十到几百行），全量拉取无压力。
   * hops 上限是库存脏数据自带环时的兜底，防上溯本身死循环。
   */
  private async assertParentAcyclic(
    selfId: string,
    newParentId: string,
  ): Promise<void> {
    if (newParentId === '0') {
      return; // 挂到根，不可能成环
    }
    if (newParentId === selfId) {
      throw new BadRequestException(PermissionMessage.CycleDetected);
    }

    const all = await this.em.find(PermissionEntity, {
      where: { deleted: false },
    });
    const byId = new Map(all.map((p) => [p.id, p]));

    const parent = byId.get(newParentId);
    if (!parent) {
      throw new BadRequestException(PermissionMessage.ParentNotFound);
    }

    let cursor = parent.parentId;
    let hops = 0;
    while (cursor !== '0') {
      if (cursor === selfId) {
        throw new BadRequestException(PermissionMessage.CycleDetected);
      }
      const next = byId.get(cursor);
      // 指向已软删父的存量行：链在这里断掉，继续上溯只会空转
      if (!next) {
        break;
      }
      cursor = next.parentId;
      if (++hops > all.length) {
        throw new BadRequestException(PermissionMessage.CycleDetected);
      }
    }
  }

  /** 目标用户必须存在且未软删（启用与否不影响 —— 禁用账号的授权面也要可管理） */
  private async assertUserExists(userId: string): Promise<void> {
    const user = await this.em.findOne(UserEntity, {
      where: { id: userId, deleted: false },
    });
    if (!user) {
      throw new NotFoundException(PermissionMessage.UserNotFound);
    }
  }

  /**
   * 权限 ID → 启用中的权限实体。任何一个 ID 查不到、被禁用或已软删，
   * 整个请求失败并报出具体 ID —— 不做「部分成功」，管理员看到的必须是
   * 确定的授权结果（与 user 模块 resolveRoles 同一取舍）。
   */
  private async resolvePermissions(
    permissionIds: string[],
  ): Promise<PermissionEntity[]> {
    if (permissionIds.length === 0) {
      return [];
    }
    // DTO 的 @ArrayUnique 已去重，In() 查询不会因重复值膨胀
    const permissions = await this.em.find(PermissionEntity, {
      where: {
        id: In(permissionIds),
        deleted: false,
        status: PermissionStatus.Enabled,
      },
    });

    const found = new Set(permissions.map((permission) => permission.id));
    const missing = permissionIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `${PermissionMessage.NotAvailable}: ${missing.join(', ')}`,
      );
    }

    return permissions;
  }

  /** 唯一键冲突 → 对外 400；其余异常原样抛回（数据库连不上等仍按 500 冒泡） */
  private rethrowUniqueViolation(error: unknown): never {
    if (isUniqueViolationOn(error, UK_PERMISSION_CODE)) {
      throw new BadRequestException(PermissionMessage.CodeAlreadyTaken);
    }
    throw error;
  }

  /** 组装管理端视图（显式挑字段，不展开实体） */
  private toPermissionDetail(p: PermissionEntity): PermissionDetail {
    return {
      id: p.id,
      parentId: p.parentId,
      permissionName: p.permissionName,
      permissionCode: p.permissionCode,
      permissionType: p.permissionType,
      menuUrl: p.menuUrl ?? null,
      apiUrl: p.apiUrl ?? null,
      method: p.method ?? null,
      icon: p.icon ?? null,
      sort: p.sort,
      status: p.status,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }
}
