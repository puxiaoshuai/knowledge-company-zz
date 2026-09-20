import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  PermissionStatus,
  PermissionType,
} from '../entities/permission.entity.js';

/** 权限列表查询（仅管理员） */
export class QueryPermissionDto {
  /** 权限名称（模糊，ILIKE 不区分大小写） */
  @IsOptional()
  @IsString()
  permissionName?: string;

  /** 权限编码（模糊，ILIKE 不区分大小写） */
  @IsOptional()
  @IsString()
  permissionCode?: string;

  /**
   * 权限类型：1 菜单 2 按钮 3 接口。
   *
   * 用 @IsIn 而不是裸 @IsInt：非法值若被放行，会静默走到
   * `WHERE permission_type = 7` 返回空列表 —— 最难排查的「不报错但没数据」。
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([PermissionType.Menu, PermissionType.Button, PermissionType.Api], {
    message: '权限类型只能是 1（菜单）、2（按钮）或 3（接口）',
  })
  permissionType?: PermissionType;

  /** 状态：0 禁用 1 启用 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([PermissionStatus.Disabled, PermissionStatus.Enabled], {
    message: '状态只能是 0（禁用）或 1（启用）',
  })
  status?: PermissionStatus;

  /** 页码，从 1 开始 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  /** 每页条数 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}
