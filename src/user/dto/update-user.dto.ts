import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { RoleCode } from '../../auth/constants/role.constant.js';
import { UserStatus } from '../../auth/entities/user.entity.js';

/** 同 create-user.dto.ts，见那里的说明 */
const trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/**
 * 修改用户（仅管理员）。所有字段可选，只改传了的。
 *
 * ## 刻意不声明的字段
 *
 * - `username`：它是登录凭据与审计锚点。改名会让 JWT 载荷里的 username、
 *   kh_refresh_token 的历史记录、审核记录里的 reviewerName 全部失配。
 *   真要支持得单独做一个带「改后强制下线 + 审计」的接口。
 * - `password`：改密码走 `POST /auth/change-password`。管理员直接给他人设密码
 *   是另一件事（语义、通知、风险都不同），不在本次范围。
 * - `id` / `tokenVersion` / `deleted` / `lastLoginAt` / `createdAt`：内部字段。
 *
 * 它们**不在 DTO 里声明**，因此传了会被全局 ValidationPipe 的
 * forbidNonWhitelisted 直接判 400（`property username should not exist`）。
 * 这是刻意的：为了给出中文报错而声明它们再手动拒绝，等于对外「承认」
 * 这两个字段存在，反而更难在文档里说清，且与今天任何未声明字段的行为不一致。
 */
export class UpdateUserDto {
  /** 真实姓名 / 显示名 */
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '姓名长度最多 50 位' })
  realName?: string;

  /** 头像 URL */
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: '头像地址长度最多 500 位' })
  avatar?: string;

  /**
   * 邮箱。
   *
   * 改成与当前不同的值时，服务端会强制把 `email_verified` 重置为 0
   * 并作废该用户待用的激活 token（否则旧激活链接能把**新**邮箱直接标记为已验证，
   * 见接口文档「已知缺口」）。想同时保持已验证，就在同一个请求里显式传
   * `emailVerified: true` —— 它在这个字段之后应用。
   */
  @IsOptional()
  @trim()
  @IsEmail({}, { message: '邮箱格式不正确' })
  @MaxLength(100, { message: '邮箱长度最多 100 位' })
  email?: string;

  /**
   * 邮箱是否已验证。
   *
   * 暴露它是因为后台建号时 `email_verified` 就是直接置 1 的（管理员断言该地址），
   * 改邮箱会把标记清掉，管理员需要能把它恢复回来。
   */
  @IsOptional()
  @IsBoolean({ message: 'emailVerified 必须是布尔值' })
  emailVerified?: boolean;

  /**
   * 状态：0 禁用 1 启用。
   *
   * 禁用会**立即吊销该用户全部令牌**，因此日后重新启用时旧令牌不会复活，
   * 必须重新登录（这修掉了接口文档里「复职后原会话无需重新登录」那个缺口）。
   */
  @IsOptional()
  @Type(() => Number)
  @IsIn([UserStatus.Disabled, UserStatus.Enabled], {
    message: '状态只能是 0（禁用）或 1（启用）',
  })
  status?: UserStatus;

  /**
   * 角色编码列表，整体替换现有角色集合。
   *
   * 变化会**立即吊销该用户全部令牌** —— 角色内嵌在 JWT 载荷里而守卫不重取，
   * 不吊销的话改角色最长要 2 小时才生效（降权尤其不能等）。
   */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty({ message: '至少需要指定一个角色' })
  @ArrayUnique({ message: '角色不能重复' })
  @IsEnum(RoleCode, { each: true, message: '角色编码不正确' })
  roleCodes?: RoleCode[];
}
