import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RoleCode } from '../auth/constants/role.constant.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { QueryUserDto } from './dto/query-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { UserService } from './user.service.js';

/**
 * 用户管理（仅管理员）
 *
 * 角色限制用**类级** `@Roles(RoleCode.Admin)` 而不是逐个方法标注：
 * 本控制器的每一条路由都只该给管理员，类级标注让「新加一个方法忘记加装饰器」
 * 这个失误从「默认放行」变成「默认拒绝」。
 *
 * 再叠一道类级权限码门 `@RequirePermissions('system:user')`（种子里的
 * 「用户管理」菜单码），全路由继承；对 ROLE_ADMIN 隐式全通过，
 * 当前不改变任何行为，作用是把权限码机制铺到整个管理面。
 *
 * 「当前是谁」一律取自 JWT（@CurrentUser），不从请求体读 ——
 * 删除自己、禁用自己这类判定全靠它。
 */
@Roles(RoleCode.Admin)
@RequirePermissions('system:user')
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  /**
   * 分页查询用户列表。
   *
   * 支持 username / email 模糊、status 与 roleCode 精确筛选，
   * 按创建时间倒序。已软删的用户永远不出现在结果里。
   */
  @Get()
  findAll(@Query() query: QueryUserDto) {
    return this.userService.findAll(query);
  }

  /**
   * 启用中的角色选项（下拉框用）。
   *
   * 必须注册在 `@Get(':id')` **之前**，否则 "roles" 会被当成一个用户 id 吃掉。
   * （同 document.controller.ts 里 reviews/tasks 的处理。）
   */
  @Get('roles')
  listRoles() {
    return this.userService.listRoles();
  }

  /** 用户详情 */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.userService.findOne(id);
  }

  /**
   * 新增用户。
   *
   * 管理员直接指定密码与角色，邮箱标记为已验证且**不发激活邮件**
   * （见 UserService.create 的说明）。创建人取自 JWT，仅用于日志。
   */
  @Post()
  create(@Body() dto: CreateUserDto, @CurrentUser() user: AuthenticatedUser) {
    return this.userService.create(dto, user.id);
  }

  /**
   * 修改用户。
   *
   * username / password 不可改，传了会被 forbidNonWhitelisted 判 400。
   * 改密码请走 `POST /auth/change-password`。
   *
   * 禁用、角色变更、邮箱验证状态降为 0 都会**立即吊销该用户全部令牌**。
   */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.userService.update(id, dto, user.id);
  }

  /** 软删除用户，并立即吊销其全部令牌 */
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.userService.remove(id, user.id);
  }
}
