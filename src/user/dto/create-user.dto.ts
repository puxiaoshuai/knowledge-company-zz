import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RoleCode } from '../../auth/constants/role.constant.js';
import { UserStatus } from '../../auth/entities/user.entity.js';

/**
 * 先 trim 再去校验格式。
 *
 * 与 register.dto.ts 里那个同名的模块私有工厂是同一份实现，刻意**不**抽到公共位置：
 * 它是 DTO 层的 class-transformer 关注点，放进 service 层的 util 文件并不干净；
 * 而为此新建一个 decorator 文件，换来的也只是省下这 4 行。仓内已有先例
 * （password-reset 与 email-verification 各写一份 consumeCooldown，并注明为何不共用）。
 */
const trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/**
 * 新增用户（仅管理员）。
 *
 * 与 POST /auth/register 的差别只有三处，其余校验**逐字对齐**：
 * 1. 可以指定角色（注册固定授予 ROLE_USER）；
 * 2. `email_verified` 直接置 1，且**不发激活邮件** —— 这条链路没有「证明邮箱归属」
 *    的环节，verified 表达的是「管理员断言了这个地址」，而不是「用户证明了它」；
 * 3. 可以指定初始状态（便于预置人员、批量导入时先建禁用账号）。
 *
 * 用户名与密码的约束必须和注册一致，否则后台建号就成了绕过注册策略的后门
 * （注册不允许的弱密码或怪用户名，从这里能建出来）。
 */
export class CreateUserDto {
  /** 登录用户名（3-50 位，仅字母 / 数字 / 下划线） */
  @IsString()
  @Matches(/^[a-zA-Z0-9_]{3,50}$/, {
    message: '用户名只能包含字母、数字、下划线，长度 3-50',
  })
  username: string;

  /** 初始密码（6-64 位） */
  @IsString()
  @MinLength(6, { message: '密码长度至少 6 位' })
  @MaxLength(64, { message: '密码长度最多 64 位' })
  password: string;

  /**
   * 邮箱。与注册一样是**必填**：邮箱是找回密码的唯一通道，
   * 没邮箱的账号一旦忘记密码就永久无法自助恢复。
   * 库里允许 NULL 只是为了兼容存量账号，不该被新接口当成可选。
   */
  @trim()
  @IsEmail({}, { message: '邮箱格式不正确' })
  @MaxLength(100, { message: '邮箱长度最多 100 位' })
  email: string;

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
   * 初始状态，默认启用。
   *
   * 允许直接建出禁用账号（预置人员、批量导入的先建后开），
   * 这种账号能查到、能被改，但登不进来。
   */
  @IsOptional()
  @Type(() => Number)
  @IsIn([UserStatus.Disabled, UserStatus.Enabled], {
    message: '状态只能是 0（禁用）或 1（启用）',
  })
  status?: UserStatus;

  /**
   * 角色编码列表，至少一个且不重复。
   *
   * 用编码而不是 kh_role.id：编码是代码里的封闭集合（RoleCode），
   * dev/test/prod 恒等；而雪花 id 是库生成的，把 REST 契约建在它上面很脆。
   * 出参也返回编码，前端用 GET /users/roles 的映射表渲染中文名即可。
   *
   * @ArrayUnique 不是可选的：kh_user_role 有 UNIQUE(user_id, role_id)，
   * 客户端传重复编码会在插入时撞 23505，落成一个 500。
   *
   * @ArrayNotEmpty 是刻意的保护：没有角色的账号能登录但什么都做不了
   * （@Roles 全拒），几乎总是操作失误，拦住它比事后排查便宜。
   */
  @IsArray()
  @ArrayNotEmpty({ message: '至少需要指定一个角色' })
  @ArrayUnique({ message: '角色不能重复' })
  @IsEnum(RoleCode, { each: true, message: '角色编码不正确' })
  roleCodes: RoleCode[];
}
