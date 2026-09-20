import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RoleCode } from '../auth/constants/role.constant.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type.js';
import { AssignTeamMembersDto } from './dto/assign-team-members.dto.js';
import { CreateTeamDto } from './dto/create-team.dto.js';
import { QueryTeamDto } from './dto/query-team.dto.js';
import { QueryTeamMembersDto } from './dto/query-team-members.dto.js';
import { UpdateTeamDto } from './dto/update-team.dto.js';
import { TeamService } from './team.service.js';

/**
 * 团队管理（仅管理员）。
 *
 * 两道类级门 AND：@Roles(RoleCode.Admin) 是粗粒度角色门（安全默认，
 * 新加方法忘加装饰器时默认拒绝）；@RequirePermissions('system:team')
 * 是权限码门（种子里的「团队管理」菜单码），全路由继承。
 * 对 ROLE_ADMIN 权限码隐式全通过，当前不改变任何行为 —— 把这道路由
 * 放宽给「被授权的非管理员」时只需调整角色门，权限码门已就位。
 *
 * `tree` 必须注册在 `@Get(':id')` 之前，否则 "tree" 会被当成团队 id 吃掉
 * （同 user.controller.ts 里 roles 的处理）。
 */
@Roles(RoleCode.Admin)
@RequirePermissions('system:team')
@Controller('teams')
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  /** 全量团队树（含禁用节点，组织树用） */
  @Get('tree')
  findTree() {
    return this.teamService.findTree();
  }

  /** 平铺分页列表 */
  @Get()
  findAll(@Query() query: QueryTeamDto) {
    return this.teamService.findAll(query);
  }

  /** 团队详情 */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.teamService.findOne(id);
  }

  /** 新增团队。leaderId 只是指针，不自动写成员表（见 CreateTeamDto 说明） */
  @Post()
  create(@Body() dto: CreateTeamDto, @CurrentUser() user: AuthenticatedUser) {
    return this.teamService.create(dto, user.id);
  }

  /** 修改团队（改 parentId 防环、改编码查重、改负责人校验） */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTeamDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.teamService.update(id, dto, user.id);
  }

  /** 软删除团队。有子团队时 400；同事务清空成员表 */
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.teamService.remove(id, user.id);
  }

  /** 成员分页列表（带用户信息） */
  @Get(':id/members')
  listMembers(@Param('id') id: string, @Query() query: QueryTeamMembersDto) {
    return this.teamService.listMembers(id, query);
  }

  /**
   * 整体替换团队成员。空数组 = 清空成员。
   * leader 一致性规则见 AssignTeamMembersDto 的说明。
   */
  @Put(':id/members')
  assignMembers(
    @Param('id') id: string,
    @Body() dto: AssignTeamMembersDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.teamService.assignMembers(id, dto.members, user.id);
  }
}
