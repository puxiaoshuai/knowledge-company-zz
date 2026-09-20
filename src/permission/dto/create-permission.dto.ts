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
 * 新增权限（仅管理员）。
 *
 * 不做「菜单型必须填 menuUrl」之类的跨字段强校验：api_url / method 在当前
 * 架构里只是元数据，运行时校验只看 permission_code，字段间的组合约束
 * 留给前端表单 —— 后端强校验一旦加严，旧数据就会变得「不合法但改不了」。
 */
export class CreatePermissionDto {
  /** 权限名称（展示用） */
  @IsString()
  @MinLength(1, { message: '权限名称不能为空' })
  @MaxLength(50, { message: '权限名称长度最多 50 位' })
  permissionName: string;

  /**
   * 权限编码，运行时校验的唯一依据。
   * 与种子风格一致（document:list / system:permission:create）。
   * 库上是**无条件唯一**（唯一索引不带 WHERE deleted），软删行照样占用编码。
   */
  @IsString()
  @Matches(/^[a-z0-9:_-]{2,100}$/, {
    message: '权限编码只能包含小写字母、数字、冒号、下划线、连字符，长度 2-100',
  })
  permissionCode: string;

  /** 权限类型：1 菜单 2 按钮 3 接口 */
  @Type(() => Number)
  @IsIn([PermissionType.Menu, PermissionType.Button, PermissionType.Api], {
    message: '权限类型只能是 1（菜单）、2（按钮）或 3（接口）',
  })
  permissionType: PermissionType;

  /**
   * 父权限 ID，缺省 '0'（根）。
   * 刻意保持字符串不转数字：雪花 id 超出 JS 安全整数，与全部 id 字段同惯例。
   */
  @IsOptional()
  @IsString()
  parentId?: string;

  /** 菜单路径（菜单型权限用） */
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: '菜单路径长度最多 200 位' })
  menuUrl?: string;

  /** 接口 URL 模式（接口型权限的元数据） */
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: '接口路径长度最多 500 位' })
  apiUrl?: string;

  /** HTTP 方法（接口型权限的元数据） */
  @IsOptional()
  @IsIn(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], {
    message: 'HTTP 方法只能是 GET / POST / PUT / PATCH / DELETE',
  })
  method?: string;

  /** 图标（菜单型权限用） */
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '图标名长度最多 50 位' })
  icon?: string;

  /** 排序值，同级升序 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort?: number;

  /** 初始状态，默认启用 */
  @IsOptional()
  @Type(() => Number)
  @IsIn([PermissionStatus.Disabled, PermissionStatus.Enabled], {
    message: '状态只能是 0（禁用）或 1（启用）',
  })
  status?: PermissionStatus;
}
