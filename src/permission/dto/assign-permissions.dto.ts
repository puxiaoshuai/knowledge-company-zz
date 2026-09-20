import { ArrayUnique, IsArray, IsString } from 'class-validator';

/**
 * 给角色 / 用户分配权限（整体替换现有授权），两个 PUT 接口共用。
 *
 * 传的是**全集**：服务端先删后插，不在列表里的现有授权一并收回。
 * 空数组 = 清空全部授权 —— 与 roleCodes 的 @ArrayNotEmpty 刻意不同，
 * 「收回某角色的全部权限」是合法且常见的管理动作，拦住它反而逼人去改库。
 *
 * @ArrayUnique 必须有：kh_role_permission / kh_user_permission 都有
 * UNIQUE(x_id, permission_id)，重复 id 会撞 23505 落成 500。
 */
export class AssignPermissionsDto {
  /** 权限 ID 全集（雪花，字符串） */
  @IsArray()
  @ArrayUnique({ message: '权限不能重复' })
  @IsString({ each: true, message: '权限 ID 必须是字符串' })
  permissionIds: string[];
}
