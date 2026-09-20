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
import { AssignPermissionsDto } from './dto/assign-permissions.dto.js';
import { CreatePermissionDto } from './dto/create-permission.dto.js';
import { QueryPermissionDto } from './dto/query-permission.dto.js';
import { UpdatePermissionDto } from './dto/update-permission.dto.js';
import { PermissionService } from './permission.service.js';

/**
 * 权限管理（仅管理员）。
 *
 * 两道类级门 AND：@Roles(RoleCode.Admin)（安全默认）+ 权限码门
 * @RequirePermissions('system:permission')（种子里的「权限管理」菜单码）。
 * 读接口（树 / 列表 / 授权回显与替换）全部**继承**类级权限码；
 * 写接口用方法级按钮码**覆盖**它（getAllAndOverride 按 handler → class
 * 取第一个命中，create / edit / delete 各自要求更细的按钮级权限）。
 * 注意本控制器**不含** GET /permissions/me —— 它只需登录不需要管理员角色，
 * 放在独立的 my-permission.controller.ts 里声明。
 *
 * 静态段路由（tree / role / user）必须注册在参数路由之前；
 * 当前没有 GET /permissions/:id，但 PATCH/DELETE :id 与它们方法不同不冲突，
 * 顺序约束沿用 document.controller.ts 的惯例并注释在先。
 */
@Roles(RoleCode.Admin)
@RequirePermissions('system:permission')
@Controller('permissions')
export class PermissionController {
  constructor(private readonly permissionService: PermissionService) {}

  /** 全量权限树（含禁用节点，管理端勾选树用） */
  @Get('tree')
  findTree() {
    return this.permissionService.findTree();
  }

  /** 平铺分页列表 */
  @Get()
  findAll(@Query() query: QueryPermissionDto) {
    return this.permissionService.findAll(query);
  }

  /** 角色已分配的权限 ID 列表（授权回显） */
  @Get('role/:roleId')
  listRolePermissions(@Param('roleId') roleId: string) {
    return this.permissionService.listRolePermissions(roleId);
  }

  /** 用户直授的权限 ID 列表（授权回显） */
  @Get('user/:userId')
  listUserPermissions(@Param('userId') userId: string) {
    return this.permissionService.listUserPermissions(userId);
  }

  /**
   * 新增权限。方法级 `system:permission:create` **覆盖**类级的
   * `system:permission` —— 要求按钮级权限而不是看一眼菜单的权限。
   */
  @RequirePermissions('system:permission:create')
  @Post()
  create(
    @Body() dto: CreatePermissionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.permissionService.create(dto, user.id);
  }

  /**
   * 整体替换角色的权限授权。空数组 = 清空。
   * 不吊销任何用户令牌：权限实时查库，变更即时生效。
   */
  @Put('role/:roleId')
  assignRolePermissions(
    @Param('roleId') roleId: string,
    @Body() dto: AssignPermissionsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.permissionService.assignRolePermissions(
      roleId,
      dto.permissionIds,
      user.id,
    );
  }

  /** 整体替换用户直授权限。空数组 = 清空。同样即时生效、不吊销令牌 */
  @Put('user/:userId')
  assignUserPermissions(
    @Param('userId') userId: string,
    @Body() dto: AssignPermissionsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.permissionService.assignUserPermissions(
      userId,
      dto.permissionIds,
      user.id,
    );
  }

  /** 修改权限（改 parentId 防环、改 code 查重） */
  @RequirePermissions('system:permission:edit')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePermissionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.permissionService.update(id, dto, user.id);
  }

  /**
   * 软删除权限。有未删除子权限时 400；
   * 同事务清理角色 / 用户授权引用（卫生措施，防授权回显出现僵尸 id）。
   */
  @RequirePermissions('system:permission:delete')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.permissionService.remove(id, user.id);
  }
}
