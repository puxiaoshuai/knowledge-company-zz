import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  PermissionStatus,
  PermissionType,
} from '../entities/permission.entity.js';

/**
 * 修改权限（仅管理员）。所有字段可选，只改传了的。
 *
 * ## 刻意不声明的字段
 *
 * - `id`：主键。改编码已经足够危险，改 id 会让 kh_role_permission /
 *   kh_user_permission 里的引用集体悬空。
 * - `createdAt` / `updatedAt` / `deleted`：内部字段。
 *
 * 它们不在 DTO 里声明，传了会被全局 ValidationPipe 的 forbidNonWhitelisted
 * 直接判 400 —— 与 user 模块的 UpdateUserDto 同一防越权字段机制。
 */
export class UpdatePermissionDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: '权限名称不能为空' })
  @MaxLength(50, { message: '权限名称长度最多 50 位' })
  permissionName?: string;

  /**
   * 权限编码。改成与现有（含软删）权限重复的值会被拒绝；
   * 改编码等于换掉了所有 @RequirePermissions('旧码') 引用，
   * 调用方要自己确认代码已同步。
   */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9:_-]{2,100}$/, {
    message: '权限编码只能包含小写字母、数字、冒号、下划线、连字符，长度 2-100',
  })
  permissionCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsIn([PermissionType.Menu, PermissionType.Button, PermissionType.Api], {
    message: '权限类型只能是 1（菜单）、2（按钮）或 3（接口）',
  })
  permissionType?: PermissionType;

  /**
   * 父权限 ID。不能指向自己或自己的后代（服务端会沿 parent 链上溯检测），
   * 否则树会断成环、前端递归渲染直接栈溢出。
   */
  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200, { message: '菜单路径长度最多 200 位' })
  menuUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: '接口路径长度最多 500 位' })
  apiUrl?: string;

  @IsOptional()
  @IsIn(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], {
    message: 'HTTP 方法只能是 GET / POST / PUT / PATCH / DELETE',
  })
  method?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '图标名长度最多 50 位' })
  icon?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort?: number;

  @IsOptional()
  @Type(() => Number)
  @IsIn([PermissionStatus.Disabled, PermissionStatus.Enabled], {
    message: '状态只能是 0（禁用）或 1（启用）',
  })
  status?: PermissionStatus;
}
