import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager, In } from 'typeorm';
import { UserEntity, UserStatus } from '../auth/entities/user.entity.js';
import { buildTree } from '../common/tree.util.js';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { TeamMessage } from './constants/team.constant.js';
import {
  TeamMemberRole,
  TeamMemberEntity,
} from './entities/team-member.entity.js';
import { TeamEntity, TeamStatus } from './entities/team.entity.js';
import { CreateTeamDto } from './dto/create-team.dto.js';
import { QueryTeamDto } from './dto/query-team.dto.js';
import { QueryTeamMembersDto } from './dto/query-team-members.dto.js';
import { UpdateTeamDto } from './dto/update-team.dto.js';
import type {
  DeleteTeamResult,
  TeamDetail,
  TeamListResult,
  TeamMemberDetail,
  TeamMemberListResult,
  TeamMembersResult,
  TeamTreeNode,
} from './types/team.type.js';

/** 发给管理员的提示：软删记录一律按不存在处理 */
const TEAM_NOT_FOUND = new NotFoundException(TeamMessage.NotFound);

/**
 * 团队管理（仅管理员）：树 / CRUD + 成员管理。
 *
 * 与 permission 模块同一套约定：软删不可见、只返回显式 interface、
 * 关联表整体替换（同事务先删后插）、插入后重读回显时间戳。
 *
 * 两条本模块特有的不变量：
 *
 * 1. **leader_id 是权威字段**。kh_team.leader_id 指向负责人，成员表里的
 *    member_role = 'leader' 只是标注；两边不强制同步，由 PUT members 的
 *    一致性规则（见 assignMembers）保证不出现互相矛盾的组合。
 * 2. **团队是组织配置而非安全边界**。kh_document.team_id 只是归属标记，
 *    文档可见性不随团队走，删团队不会动任何文档（残留 teamId 是已知缺口）。
 */
@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name);

  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {}

  /** 全量团队树（含禁用节点，管理端组织树用） */
  async findTree(): Promise<TeamTreeNode[]> {
    const teams = await this.em.find(TeamEntity, { where: { deleted: false } });

    return buildTree<TeamEntity, TeamTreeNode>(teams, (t, children) => ({
      id: t.id,
      parentId: t.parentId,
      teamName: t.teamName,
      teamCode: t.teamCode ?? null,
      description: t.description ?? null,
      leaderId: t.leaderId ?? null,
      sort: t.sort,
      status: t.status,
      children,
    }));
  }

  /** 平铺分页（支持名称 / 编码模糊、状态精确筛选） */
  async findAll(query: QueryTeamDto): Promise<TeamListResult> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const qb = this.em
      .createQueryBuilder(TeamEntity, 't')
      .where('t.deleted = :deleted', { deleted: false });

    if (query.teamName) {
      qb.andWhere('t.team_name ILIKE :teamName', {
        teamName: `%${query.teamName}%`,
      });
    }
    if (query.teamCode) {
      qb.andWhere('t.team_code ILIKE :teamCode', {
        teamCode: `%${query.teamCode}%`,
      });
    }
    if (query.status !== undefined) {
      qb.andWhere('t.status = :status', { status: query.status });
    }

    qb.orderBy('t.sort', 'ASC').addOrderBy('t.id', 'ASC');
    qb.skip((page - 1) * pageSize).take(pageSize);

    const [teams, total] = await qb.getManyAndCount();
    return {
      items: teams.map((team) => this.toTeamDetail(team)),
      total,
      page,
      pageSize,
    };
  }

  /** 团队详情 */
  async findOne(id: string): Promise<TeamDetail> {
    return this.toTeamDetail(await this.findTeamOrThrow(id));
  }

  /** 新增团队。父团队须存在；leaderId 须为启用用户；teamCode 应用层查重 */
  async create(dto: CreateTeamDto, actorId: string): Promise<TeamDetail> {
    const parentId = dto.parentId ?? '0';
    if (parentId !== '0') {
      await this.assertParentExists(parentId);
    }

    const teamCode = dto.teamCode ?? null;
    if (teamCode) {
      // 库上没有唯一索引（刻意不动 DDL），应用层查重；并发窗口记录为已知缺口
      const taken = await this.em.findOne(TeamEntity, {
        where: { teamCode, deleted: false },
      });
      if (taken) {
        throw new BadRequestException(TeamMessage.CodeAlreadyTaken);
      }
    }

    if (dto.leaderId) {
      await this.assertLeaderAvailable(dto.leaderId);
    }

    const team = this.em.create(TeamEntity, {
      id: nextSnowflakeId(),
      parentId,
      teamName: dto.teamName,
      teamCode,
      description: dto.description ?? null,
      leaderId: dto.leaderId ?? null,
      sort: dto.sort ?? 0,
      status: dto.status ?? TeamStatus.Enabled,
      deleted: false,
    });

    // 单表写入，不需要事务；无库级唯一约束可撞，无需 23505 翻译
    await this.em.insert(TeamEntity, team);

    this.logger.log(
      `团队已创建：actor=${actorId} id=${team.id} name=${team.teamName}`,
    );

    // 重读回显时间戳（@CreateDateColumn / @UpdateDateColumn 由数据库填）
    return this.toTeamDetail(await this.findTeamOrThrow(team.id));
  }

  /** 修改团队（改 parentId 防环、改 teamCode 查重、改 leaderId 校验用户） */
  async update(
    id: string,
    dto: UpdateTeamDto,
    actorId: string,
  ): Promise<TeamDetail> {
    const team = await this.findTeamOrThrow(id);

    if (dto.parentId !== undefined && dto.parentId !== team.parentId) {
      // 包含「父存在」与「不成环」两个断言
      await this.assertParentAcyclic(id, dto.parentId);
    }
    if (
      dto.teamCode !== undefined &&
      dto.teamCode !== (team.teamCode ?? null)
    ) {
      await this.assertTeamCodeAvailable(dto.teamCode, id);
    }
    if (
      dto.leaderId !== undefined &&
      dto.leaderId !== (team.leaderId ?? null)
    ) {
      await this.assertLeaderAvailable(dto.leaderId);
    }

    const changes: Partial<TeamEntity> = {};
    if (dto.parentId !== undefined) {
      changes.parentId = dto.parentId;
    }
    if (dto.teamName !== undefined) {
      changes.teamName = dto.teamName;
    }
    if (dto.teamCode !== undefined) {
      changes.teamCode = dto.teamCode;
    }
    if (dto.description !== undefined) {
      changes.description = dto.description;
    }
    if (dto.leaderId !== undefined) {
      changes.leaderId = dto.leaderId;
    }
    if (dto.sort !== undefined) {
      changes.sort = dto.sort;
    }
    if (dto.status !== undefined) {
      changes.status = dto.status;
    }

    // em.update 传空对象会抛 UpdateValuesMissingError（全字段可选的 DTO 可能什么都不带）
    if (Object.keys(changes).length > 0) {
      await this.em.update(TeamEntity, id, changes);
    }

    this.logger.log(
      `团队已更新：actor=${actorId} id=${id} fields=${Object.keys(changes).join(',') || '(无)'}`,
    );

    return this.toTeamDetail(await this.findTeamOrThrow(id));
  }

  /**
   * 软删除团队。
   *
   * 有未删除子团队时拒绝；同事务清空 kh_team_member。
   * 注意 kh_document.team_id 没有外键、也不在这里清理 —— 团队删除后
   * 存量文档会残留指向已删团队的 teamId，已记录为已知缺口（前端按「团队已不存在」处理）。
   */
  async remove(id: string, actorId: string): Promise<DeleteTeamResult> {
    await this.findTeamOrThrow(id);

    const childCount = await this.em.count(TeamEntity, {
      where: { parentId: id, deleted: false },
    });
    if (childCount > 0) {
      throw new BadRequestException(TeamMessage.HasChildren);
    }

    await this.em.transaction(async (tx) => {
      await tx.update(TeamEntity, id, { deleted: true });
      await tx.delete(TeamMemberEntity, { teamId: id });
    });

    this.logger.log(`团队已软删：actor=${actorId} id=${id}`);

    return { id, deleted: true };
  }

  /** 成员分页列表（join kh_user 带用户信息，按加入时间升序） */
  async listMembers(
    teamId: string,
    query: QueryTeamMembersDto,
  ): Promise<TeamMemberListResult> {
    await this.findTeamOrThrow(teamId);

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const qb = this.em
      .createQueryBuilder(TeamMemberEntity, 'tm')
      .innerJoin(UserEntity, 'u', 'u.id = tm.user_id')
      .where('tm.team_id = :teamId', { teamId })
      .orderBy('tm.created_at', 'ASC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [members, total] = await qb.getManyAndCount();

    // getMany 只回关联表实体，用户信息要按 userId 批量补齐（避免逐行查询）
    const users = await this.em.find(UserEntity, {
      where: { id: In(members.map((m) => m.userId)) },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    return {
      items: members.map((member) =>
        this.toMemberDetail(member, userById.get(member.userId)),
      ),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 整体替换团队成员。
   *
   * 一致性规则（保证 leader_id 权威字段与成员标注不矛盾）：
   * - 成员里 leader 标注最多 1 个；
   * - 团队已有 leader_id 且与成员里的 leader 不同 → 400（先 PATCH 改负责人再换血）；
   * - leader_id 为空且成员里有 leader → 同事务把 leader_id 补上；
   * - 成员里没有 leader → 不动 leader_id。
   */
  async assignMembers(
    teamId: string,
    members: { userId: string; memberRole: TeamMemberRole }[],
    actorId: string,
  ): Promise<TeamMembersResult> {
    const team = await this.findTeamOrThrow(teamId);

    // 对象数组没法用 @ArrayUnique，去重只能在服务层做
    const userIds = members.map((member) => member.userId);
    if (new Set(userIds).size !== userIds.length) {
      throw new BadRequestException(TeamMessage.DuplicateMember);
    }

    const leaders = members.filter(
      (member) => member.memberRole === TeamMemberRole.Leader,
    );
    if (leaders.length > 1) {
      throw new BadRequestException(TeamMessage.MultipleLeaders);
    }
    const leaderId = leaders[0]?.userId ?? null;
    if (leaderId && team.leaderId && team.leaderId !== leaderId) {
      throw new BadRequestException(TeamMessage.LeaderConflict);
    }

    if (userIds.length > 0) {
      const users = await this.em.find(UserEntity, {
        where: {
          id: In(userIds),
          deleted: false,
          status: UserStatus.Enabled,
        },
      });
      const found = new Set(users.map((user) => user.id));
      const missing = userIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(
          `${TeamMessage.MemberUserNotAvailable}: ${missing.join(', ')}`,
        );
      }
    }

    // leader_id 为空且这次成员里带了 leader → 顺手补写权威字段。
    // 已有值的情况上面已保证与成员标注一致，无需写。
    const leaderToBackfill = !team.leaderId && leaderId ? leaderId : null;

    await this.em.transaction(async (tx) => {
      // 先删后插在同一事务里，避免中间态被并发读到
      await tx.delete(TeamMemberEntity, { teamId });
      if (members.length > 0) {
        await tx.insert(
          TeamMemberEntity,
          members.map((member) => ({
            id: nextSnowflakeId(),
            teamId,
            userId: member.userId,
            memberRole: member.memberRole,
          })),
        );
      }
      if (leaderToBackfill) {
        await tx.update(TeamEntity, teamId, { leaderId: leaderToBackfill });
      }
    });

    this.logger.log(
      `团队成员已更新：actor=${actorId} teamId=${teamId} members=${members.length}` +
        (leaderToBackfill ? ` backfillLeader=${leaderToBackfill}` : ''),
    );

    // 重读回显（含补写的 leader_id 与真实入库时间）
    const rows = await this.em.find(TeamMemberEntity, {
      where: { teamId },
      order: { createdAt: 'ASC' },
    });
    const users = await this.em.find(UserEntity, {
      where: { id: In(rows.map((row) => row.userId)) },
    });
    const userById = new Map(users.map((user) => [user.id, user]));

    return {
      teamId,
      members: rows.map((row) =>
        this.toMemberDetail(row, userById.get(row.userId)),
      ),
    };
  }

  /** 取未删除的团队，否则 404 */
  private async findTeamOrThrow(id: string): Promise<TeamEntity> {
    const team = await this.em.findOne(TeamEntity, {
      where: { id, deleted: false },
    });
    if (!team) {
      throw TEAM_NOT_FOUND;
    }
    return team;
  }

  /** 父团队须存在且未删除（不要求启用） */
  private async assertParentExists(parentId: string): Promise<void> {
    const parent = await this.em.findOne(TeamEntity, {
      where: { id: parentId, deleted: false },
    });
    if (!parent) {
      throw new BadRequestException(TeamMessage.ParentNotFound);
    }
  }

  /**
   * 新父须存在，且不能是自己或自己的后代（防环）。
   * 与 permission 模块同一做法：全量拉取（组织树是配置级数据）沿 parent 链上溯，
   * hops 上限兜底库存脏数据自带环的情况。
   */
  private async assertParentAcyclic(
    selfId: string,
    newParentId: string,
  ): Promise<void> {
    if (newParentId === '0') {
      return; // 挂到根，不可能成环
    }
    if (newParentId === selfId) {
      throw new BadRequestException(TeamMessage.CycleDetected);
    }

    const all = await this.em.find(TeamEntity, { where: { deleted: false } });
    const byId = new Map(all.map((team) => [team.id, team]));

    const parent = byId.get(newParentId);
    if (!parent) {
      throw new BadRequestException(TeamMessage.ParentNotFound);
    }

    let cursor = parent.parentId;
    let hops = 0;
    while (cursor !== '0') {
      if (cursor === selfId) {
        throw new BadRequestException(TeamMessage.CycleDetected);
      }
      const next = byId.get(cursor);
      // 指向已软删父的存量行：链在这里断掉，继续上溯只会空转
      if (!next) {
        break;
      }
      cursor = next.parentId;
      if (++hops > all.length) {
        throw new BadRequestException(TeamMessage.CycleDetected);
      }
    }
  }

  /** 团队编码未被别的（未删除）团队占用；排除自己，否则「原值保存」会撞上自己那行 */
  private async assertTeamCodeAvailable(
    teamCode: string,
    selfId: string,
  ): Promise<void> {
    const taken = await this.em.findOne(TeamEntity, {
      where: { teamCode, deleted: false },
    });
    if (taken && taken.id !== selfId) {
      throw new BadRequestException(TeamMessage.CodeAlreadyTaken);
    }
  }

  /** 负责人须为存在、启用且未删除的用户（负责人要能登录、能被 @CurrentUser 追溯） */
  private async assertLeaderAvailable(leaderId: string): Promise<void> {
    const leader = await this.em.findOne(UserEntity, {
      where: { id: leaderId, deleted: false, status: UserStatus.Enabled },
    });
    if (!leader) {
      throw new BadRequestException(TeamMessage.LeaderNotAvailable);
    }
  }

  /** 组装成员视图；用户行理论上必有（外键约束），查不到时给空壳而不是崩 */
  private toMemberDetail(
    member: TeamMemberEntity,
    user?: UserEntity,
  ): TeamMemberDetail {
    return {
      id: member.id,
      userId: member.userId,
      username: user?.username ?? '',
      realName: user?.realName ?? null,
      avatar: user?.avatar ?? null,
      memberRole: member.memberRole,
      createdAt: member.createdAt,
    };
  }

  /** 组装管理端视图（显式挑字段，不展开实体） */
  private toTeamDetail(team: TeamEntity): TeamDetail {
    return {
      id: team.id,
      parentId: team.parentId,
      teamName: team.teamName,
      teamCode: team.teamCode ?? null,
      description: team.description ?? null,
      leaderId: team.leaderId ?? null,
      sort: team.sort,
      status: team.status,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
    };
  }
}
