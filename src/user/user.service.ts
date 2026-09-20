import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { hash } from 'bcryptjs';
import { EntityManager, In } from 'typeorm';
import { AuthMessage, BCRYPT_ROUNDS } from '../auth/constants/auth.constant.js';
import {
  RoleCode,
  ROLE_STATUS_ENABLED,
} from '../auth/constants/role.constant.js';
import { EmailVerificationService } from '../auth/email-verification.service.js';
import { RoleEntity } from '../auth/entities/role.entity.js';
import { UserRoleEntity } from '../auth/entities/user-role.entity.js';
import {
  EmailVerified,
  UserEntity,
  UserStatus,
} from '../auth/entities/user.entity.js';
import { TokenService } from '../auth/token.service.js';
import { UserAccessorService } from '../auth/user-accessor.service.js';
import {
  normalizeEmail,
  rethrowUserUniqueViolation,
} from '../auth/user-identity.util.js';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { UserMessage } from './constants/user.constant.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { QueryUserDto } from './dto/query-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import type {
  DeleteUserResult,
  UserDetail,
  UserListResult,
} from './types/user-detail.type.js';

/** 发给用户的提示：软删记录一律按不存在处理，所以文案里不提「已删除」 */
const USER_NOT_FOUND = new NotFoundException(UserMessage.NotFound);

/**
 * 用户管理（仅管理员）
 *
 * 三条贯穿全文件的约定：
 *
 * 1. **软删记录一律不可见**。列表、详情、修改、删除都固定带 `deleted: false`，
 *    命中已删记录统一 404「用户不存在」，而不是「已删除」——后者等于把
 *    「这个用户名曾经存在」透给一个已经无权看它的管理员。
 * 2. **不返回实体，只返回 UserDetail**。`password` 只在两处出现：写入时的 hash
 *    与登录时的 compare，永不进入响应。
 * 3. **权限相关的变更一律立即吊销令牌**。角色内嵌在 JWT 载荷里而守卫不重取，
 *    禁用也只比对 status，不吊销就等于「改了要等 2 小时才生效」。
 *    这是当前架构下唯一的杠杆，代价是被操作用户会被登出 —— 对权限变更而言
 *    这是恰当且符合预期的。
 */
@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
    private readonly accessor: UserAccessorService,
    private readonly tokenService: TokenService,
    private readonly emailVerification: EmailVerificationService,
  ) {}

  /** 分页查询用户列表（仅管理员） */
  async findAll(query: QueryUserDto): Promise<UserListResult> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const qb = this.em
      .createQueryBuilder(UserEntity, 'u')
      .where('u.deleted = :deleted', { deleted: false });

    if (query.username) {
      qb.andWhere('u.username ILIKE :username', {
        username: `%${query.username}%`,
      });
    }
    if (query.email) {
      qb.andWhere('u.email ILIKE :email', { email: `%${query.email}%` });
    }
    if (query.status !== undefined) {
      qb.andWhere('u.status = :status', { status: query.status });
    }
    if (query.roleCode) {
      // 用 EXISTS 而不是 innerJoin：innerJoin 会让 TypeORM 在 skip/take 下走
      // 「先查 DISTINCT id 子查询、再按 id 取实体」的两段式，虽然结果正确，
      // 但 EXISTS 表达的就是本意（「持有该角色」），total 的口径也一目了然。
      qb.andWhere(
        (sub) => {
          const exists = sub
            .subQuery()
            .select('1')
            .from(UserRoleEntity, 'ur')
            .innerJoin(RoleEntity, 'r', 'r.id = ur.role_id')
            .where('ur.user_id = u.id')
            .andWhere('r.role_code = :roleCode')
            .andWhere('r.status = :roleStatus')
            .getQuery();
          return `EXISTS ${exists}`;
        },
        {
          roleCode: query.roleCode,
          roleStatus: ROLE_STATUS_ENABLED,
        },
      );
    }

    qb.orderBy('u.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [users, total] = await qb.getManyAndCount();

    // 角色一次性批量取回，而不是在 map 里逐行查 —— 一页 100 条就是 100 次查询
    const roleMap = await this.accessor.loadRoleCodesByUserIds(
      users.map((user) => user.id),
    );

    return {
      items: users.map((user) =>
        this.toUserDetail(user, roleMap.get(user.id) ?? []),
      ),
      total,
      page,
      pageSize,
    };
  }

  /** 启用中的角色选项，供管理端下拉框渲染（含中文名） */
  async listRoles() {
    const items = await this.accessor.listEnabledRoles();
    return { items };
  }

  /** 用户详情（仅管理员） */
  async findOne(id: string): Promise<UserDetail> {
    const user = await this.findUserOrThrow(id);
    return this.toUserDetail(user, await this.accessor.loadRoleCodes(id));
  }

  /**
   * 新增用户（仅管理员）。
   *
   * 与 POST /auth/register 的关键差别：管理员直接指定密码与角色，
   * `email_verified` 直接置 1 且**不发激活邮件** —— 这条链路没有「证明邮箱归属」
   * 的环节，verified 表达的是「管理员断言了这个地址」。
   * 代价是邮箱写错时会得到一个「已验证的错误地址」，纠正手段是 PATCH 改邮箱
   * （那会把 verified 重置为 0）。
   */
  async create(dto: CreateUserDto, actorId: string): Promise<UserDetail> {
    const email = normalizeEmail(dto.email);

    // 预检只为避免「绝大多数重复都走成 500」；并发下会漏，真正的兜底是唯一索引
    if (
      await this.em.findOne(UserEntity, {
        where: { username: dto.username, deleted: false },
      })
    ) {
      throw new BadRequestException(AuthMessage.UsernameAlreadyTaken);
    }
    if (
      await this.em.findOne(UserEntity, { where: { email, deleted: false } })
    ) {
      throw new BadRequestException(AuthMessage.EmailAlreadyRegistered);
    }

    // 未知或被禁用的编码一律拒绝：静默忽略会让管理员以为授权成功，是最糟的失败方式
    const roles = await this.resolveRoles(dto.roleCodes);

    const user = this.em.create(UserEntity, {
      id: nextSnowflakeId(),
      username: dto.username,
      password: await hash(dto.password, BCRYPT_ROUNDS),
      email,
      emailVerified: EmailVerified.Yes,
      realName: dto.realName ?? null,
      avatar: dto.avatar ?? null,
      status: dto.status ?? UserStatus.Enabled,
      // 必须显式给 0：库里有 default，但内存实体的 undefined 会被写进 JWT 载荷，
      // 与库中的 0 比对不上，用户拿到令牌后第一次请求就会被判为登录失效
      // （与 AuthService.register 同一个坑、同一条注释）
      tokenVersion: 0,
      // 后台建号不等于登录，没有「最后登录时间」可言
      lastLoginAt: null,
      deleted: false,
    });

    try {
      // 用户与角色关联必须同事务，否则失败时会留下一个没有任何角色的用户
      await this.em.transaction(async (tx) => {
        await tx.insert(UserEntity, user);
        await tx.insert(
          UserRoleEntity,
          roles.map((role) => ({
            id: nextSnowflakeId(),
            userId: user.id,
            roleId: role.id,
          })),
        );
      });
    } catch (error) {
      // 与注册共用同一个翻译函数，保证两条链路的话术与索引名同源
      rethrowUserUniqueViolation(error);
    }

    this.logger.log(
      `用户已创建：actor=${actorId} target=${user.id} username=${user.username} roles=${dto.roleCodes.join(',')}`,
    );

    // 必须重新读一次：@CreateDateColumn / @UpdateDateColumn 是数据库在插入时填的，
    // em.create 造出来的内存实体上它们仍是 undefined，直接回显会缺这两字段。
    // 角色直接沿用刚解析出来的实体，不必再查一遍。
    const created = await this.findUserOrThrow(user.id);
    return this.toUserDetail(
      created,
      roles.map((role) => role.roleCode as RoleCode),
    );
  }

  /**
   * 修改用户（仅管理员）。
   *
   * 顺序是刻意的：**校验 → 算目标态 → 吊销令牌 → 清 Redis → 写库**。
   * 吊销在写库之前，与 PasswordResetService.reset 同一取舍 ——
   * 这个方向失败是「被登出但改动未生效」（吵闹、重试即可），
   * 反方向是「改动已生效但旧令牌仍有效」（静默，正是权限变更最怕的）。
   */
  async update(
    id: string,
    dto: UpdateUserDto,
    actorId: string,
  ): Promise<UserDetail> {
    const user = await this.findUserOrThrow(id);
    const previousRoles = await this.accessor.loadRoleCodes(id);

    // ---- 先算出「改完之后是什么样」，后面所有判定都基于它 ----
    const nextStatus = dto.status ?? user.status;
    const nextRoleCodes = dto.roleCodes ?? previousRoles;

    const nextEmail =
      dto.email === undefined ? null : normalizeEmail(dto.email);
    const emailChanged =
      nextEmail !== null && nextEmail !== (user.email ?? null);
    if (emailChanged) {
      await this.assertEmailAvailable(nextEmail, id);
    }

    /**
     * 改完之后的 email_verified。
     *
     * 三层优先级，从低到高：
     * 1. 没碰邮箱 → 保持原值；
     * 2. 改了邮箱 → **强制重置为 0**。激活 token 与 userId 绑定、不校验邮箱值，
     *    不重置的话那条旧链接会把**新**邮箱直接标记为已验证
     *    （接口文档「已知缺口」里明确要求的处理）；
     * 3. 显式传了 emailVerified → 以它为准。PATCH 的直觉是「传什么就是什么」，
     *    且此时第 2 步已把旧激活 token 作废，不存在「旧链接翻转新邮箱」的漏洞 ——
     *    管理员等于像建号时那样断言了这个地址。
     *
     * 只在这里算一次，而不是在各处分别看 changes 或 dto：那样两者一旦不一致
     * （改了邮箱但没传 emailVerified 时，changes 是 0、按 dto 看却是原值），
     * 下面的吊销判定就会与真正写进库的值相反。
     */
    const finalVerified =
      dto.emailVerified !== undefined
        ? dto.emailVerified
          ? EmailVerified.Yes
          : EmailVerified.No
        : emailChanged
          ? EmailVerified.No
          : user.emailVerified;

    // ---- 安全规则（详见接口文档「用户管理 / 安全规则」）----
    if (id === actorId && nextStatus === UserStatus.Disabled) {
      throw new BadRequestException(UserMessage.CannotDisableSelf);
    }
    if (id === actorId && finalVerified === EmailVerified.No) {
      // 不是安全漏洞而是防自锁：email_verified = 0 会让 login 与 refresh 双双 403，
      // 而本次操作很可能又吊销了令牌，结果是当场退出且登不回来
      throw new BadRequestException(UserMessage.CannotUnverifySelf);
    }
    if (
      nextStatus === UserStatus.Disabled &&
      user.status === UserStatus.Enabled
    ) {
      await this.assertNotLastEnabledAdmin(
        id,
        UserMessage.CannotDisableLastAdmin,
      );
    }
    if (
      user.status === UserStatus.Enabled &&
      previousRoles.includes(RoleCode.Admin) &&
      !nextRoleCodes.includes(RoleCode.Admin)
    ) {
      await this.assertNotLastEnabledAdmin(
        id,
        UserMessage.CannotRemoveLastAdminRole,
      );
    }

    // ---- 组装要写的字段 ----
    // 不能直接改 user 再 save：user 是自增 tokenVersion **之前**读出来的快照，
    // save 会把过期的 tokenVersion 写回去，等于把刚吊销的令牌全部复活。
    // 所以这里只维护「要写哪几个字段」，且永不含 tokenVersion。
    const changes: Partial<UserEntity> = {};
    const revokedFor: string[] = [];

    if (dto.realName !== undefined) {
      changes.realName = dto.realName;
    }
    if (dto.avatar !== undefined) {
      changes.avatar = dto.avatar;
    }

    if (nextEmail !== null) {
      changes.email = nextEmail;
    }
    if (finalVerified !== user.emailVerified) {
      changes.emailVerified = finalVerified;
    }

    if (dto.status !== undefined && dto.status !== user.status) {
      changes.status = dto.status;
      if (dto.status === UserStatus.Disabled) {
        // 禁用即吊销，顺手修掉「复职后旧令牌复活」那个缺口：
        // 重新启用时 token_version 已经变过，旧令牌不可能再通过校验。
        revokedFor.push('禁用');
      }
    }

    let nextRoleIds: string[] | null = null;
    if (dto.roleCodes !== undefined) {
      const sameSet =
        nextRoleCodes.length === previousRoles.length &&
        nextRoleCodes.every((code) => previousRoles.includes(code));
      if (!sameSet) {
        const roles = await this.resolveRoles(nextRoleCodes);
        nextRoleIds = roles.map((role) => role.id);
        // 角色内嵌在 JWT 载荷里而守卫不重取，不吊销的话最长 2h 才生效
        revokedFor.push('角色变更');
      }
    }

    // 已尝试验证状态被降为 0：不吊销的话，账号虽然登不进来，
    // 那枚残留的 access token 却还能继续用最长 2h，与「未验证不得访问」自相矛盾
    if (
      user.emailVerified === EmailVerified.Yes &&
      finalVerified === EmailVerified.No
    ) {
      revokedFor.push('邮箱置为未验证');
    }

    // ---- 先吊销，后写库 ----
    if (revokedFor.length > 0) {
      await this.tokenService.revokeAllForUser(id);
    }

    // 清 Redis 放在写库之前：Redis 不可用会抛 503，此时库里什么都没改，管理员重试即可。
    // 反序则可能留下「新邮箱 + 旧激活 token 仍有效」的中间态。
    // 只在邮箱真的变了时才碰 Redis —— 不改邮箱的 PATCH 不该依赖 Redis。
    if (emailChanged) {
      await this.emailVerification.invalidateFor(id);
    }

    await this.em.transaction(async (tx) => {
      // em.update 传空对象会抛 UpdateValuesMissingError（只改角色时 changes 是空的）
      if (Object.keys(changes).length > 0) {
        await tx.update(UserEntity, id, changes);
      }
      if (nextRoleIds) {
        // kh_user_role 没有软删列，采用整体替换；先删后插在同一事务里，
        // 避免中间态被并发读到。角色 id 已在 resolveRoles 里去过重，
        // 不会撞 UNIQUE(user_id, role_id)
        await tx.delete(UserRoleEntity, { userId: id });
        await tx.insert(
          UserRoleEntity,
          nextRoleIds.map((roleId) => ({
            id: nextSnowflakeId(),
            userId: id,
            roleId,
          })),
        );
      }
    });

    this.logger.log(
      `用户已更新：actor=${actorId} target=${id} fields=${Object.keys(changes).join(',') || '(仅角色)'} 吊销=${revokedFor.join('/') || '无'}`,
    );

    // 重新读一次，让响应里的 updatedAt / emailVerified 反映本次写入而非入参。
    // （只改角色时 kh_user 那一行并没有被更新，updatedAt 因此保持上一次的值 ——
    // 这是刻意的：角色归属本来就存在 kh_user_role 里，不该为此制造一次假写入。）
    return this.findOne(id);
  }

  /**
   * 软删除用户（仅管理员）。
   *
   * 与文档模块一致用软删：历史记录、审核记录里的 reviewerId 仍指向这个 id，
   * 物理删除会让那些引用变成悬空指针。
   *
   * 副作用（要写进文档告诉前端）：用户名与邮箱被释放 ——
   * 唯一索引带 `WHERE deleted = false`，所以同名/同邮箱可以重新注册。
   */
  async remove(id: string, actorId: string): Promise<DeleteUserResult> {
    const user = await this.findUserOrThrow(id);

    if (id === actorId) {
      // 软删 + 吊销是**对自己不可逆**的：响应返回时自己的令牌已死，
      // 无法再撤销这次操作。「最后一个管理员」规则拦不住这种情况（≥2 个管理员时它能通过）
      throw new BadRequestException(UserMessage.CannotDeleteSelf);
    }
    if (user.status === UserStatus.Enabled) {
      await this.assertNotLastEnabledAdmin(
        id,
        UserMessage.CannotDeleteLastAdmin,
      );
    }

    // 先吊销后写库，理由同 update
    await this.tokenService.revokeAllForUser(id);
    await this.em.update(UserEntity, id, { deleted: true });

    this.logger.log(
      `用户已软删：actor=${actorId} target=${id} username=${user.username}`,
    );

    return { id, deleted: true };
  }

  /** 取未删除的用户，否则 404 */
  private async findUserOrThrow(id: string): Promise<UserEntity> {
    const user = await this.em.findOne(UserEntity, {
      where: { id, deleted: false },
    });
    if (!user) {
      throw USER_NOT_FOUND;
    }
    return user;
  }

  /**
   * 邮箱是否已被别的（未删除）账号占用。
   *
   * 必须排除自己：不排除的话，把邮箱改成「它当前的值」会撞上自己那行。
   * 不过 update 里只在 email 真的变了时才调用，所以这里主要是为并发场景兜底。
   */
  private async assertEmailAvailable(
    email: string,
    selfId: string,
  ): Promise<void> {
    const taken = await this.em.findOne(UserEntity, {
      where: { email, deleted: false },
    });
    if (taken && taken.id !== selfId) {
      throw new BadRequestException(AuthMessage.EmailAlreadyRegistered);
    }
  }

  /**
   * 角色编码 → 启用中的角色实体。
   *
   * 任何一个编码查不到、或被禁用，就整个请求失败并报出具体的编码。
   * 不做「部分成功」：管理员看到的必须是确定的授权结果。
   */
  private async resolveRoles(codes: RoleCode[]): Promise<RoleEntity[]> {
    // kh_user_role 有 UNIQUE(user_id, role_id)，重复编码会在插入时撞 23505
    const unique = [...new Set(codes)];
    const roles = await this.em.find(RoleEntity, {
      where: { roleCode: In(unique), status: ROLE_STATUS_ENABLED },
    });

    const found = new Set(roles.map((role) => role.roleCode));
    const missing = unique.filter((code) => !found.has(code));
    if (missing.length > 0) {
      throw new BadRequestException(
        `${UserMessage.RoleNotAvailable}: ${missing.join(', ')}`,
      );
    }

    return roles;
  }

  /**
   * 目标不是「启用中的管理员」就直接放行；是的话必须还有别的启用中管理员兜底。
   *
   * 三条规则（删 / 禁用 / 摘角色）共用它，只是文案不同。
   *
   * 已知限制：这两个查询与随后的写入不在同一事务里、也不加行锁，
   * 因此两个管理员在同一瞬间互相降权时，两边都可能通过检查。
   * 触发条件极窄（≥2 个管理员 + 同时降权），真要根除需要在事务内
   * 对管理员行集加锁（getCount() 不能带 FOR UPDATE，得先取 id 列表），
   * 成本明显上升，故按仓内惯例显式记录为已知缺口而非假装不存在。
   */
  private async assertNotLastEnabledAdmin(
    targetId: string,
    message: string,
  ): Promise<void> {
    if (!(await this.isEnabledAdmin(targetId))) {
      return;
    }
    if ((await this.countOtherEnabledAdmins(targetId)) > 0) {
      return;
    }
    throw new BadRequestException(message);
  }

  /** 目标此刻是不是「启用中的管理员」 */
  private async isEnabledAdmin(userId: string): Promise<boolean> {
    return (
      (await this.adminScopeBuilder()
        .andWhere('u.id = :userId', { userId })
        // 有 join 时 TypeORM 生成 COUNT(DISTINCT u.id)，计数口径天然正确
        .getCount()) > 0
    );
  }

  /** 除 excludeId 外，系统里还有几个「启用中的管理员」 */
  private countOtherEnabledAdmins(excludeId: string): Promise<number> {
    return this.adminScopeBuilder()
      .andWhere('u.id <> :excludeId', { excludeId })
      .getCount();
  }

  /** 「启用中的、未删除的、持有启用中 ROLE_ADMIN 的用户」这个公共查询起点 */
  private adminScopeBuilder() {
    return this.em
      .createQueryBuilder(UserEntity, 'u')
      .innerJoin(UserRoleEntity, 'ur', 'ur.user_id = u.id')
      .innerJoin(RoleEntity, 'r', 'r.id = ur.role_id')
      .where('r.role_code = :roleCode', { roleCode: RoleCode.Admin })
      .andWhere('r.status = :roleEnabled', { roleEnabled: ROLE_STATUS_ENABLED })
      .andWhere('u.status = :enabled', { enabled: UserStatus.Enabled })
      .andWhere('u.deleted = :deleted', { deleted: false });
  }

  /**
   * 组装管理端的用户视图。
   *
   * 复用 toAuthUser 拿到共享字段（password 被它的显式挑字段挡住），
   * 再补上管理端特有的 status / updatedAt —— AuthUser 刻意不含 status，
   * 因为对**普通用户自己**来说 0/1 只会引起歧义，而管理员必须看到他。
   */
  private toUserDetail(user: UserEntity, roles: RoleCode[]): UserDetail {
    return {
      ...this.accessor.toAuthUser(user, roles),
      status: user.status,
      updatedAt: user.updatedAt,
    };
  }
}
