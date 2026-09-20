import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { RoleCode } from '../../auth/constants/role.constant.js';
import { UserStatus } from '../../auth/entities/user.entity.js';

/** 用户列表查询（仅管理员） */
export class QueryUserDto {
  /** 用户名（模糊，ILIKE 不区分大小写） */
  @IsOptional()
  @IsString()
  username?: string;

  /** 邮箱（模糊，ILIKE 不区分大小写） */
  @IsOptional()
  @IsString()
  email?: string;

  /**
   * 状态：0 禁用 1 启用。
   *
   * 类型写成 UserStatus（`0 | 1` 联合）而不是 number，这样赋值给实体字段时
   * 类型才是自洽的。联合类型会让 emitDecoratorMetadata 发出 `Object`、
   * 拿不到隐式转换，但这里的 @Type(() => Number) 是**显式**指定目标类型的，
   * 不依赖反射元数据，所以 `?status=1` 仍会被正确转成数字。
   *
   * 用 @IsIn 而不是裸 @IsInt：`?status=7` 若被放行，会静默走到
   * `WHERE status = 7` 返回空列表 —— 那是最难排查的一类「接口没报错但没数据」。
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([UserStatus.Disabled, UserStatus.Enabled], {
    message: '状态只能是 0（禁用）或 1（启用）',
  })
  status?: UserStatus;

  /**
   * 角色编码（精确过滤）。
   *
   * 刻意是单值而不是数组：Query 里的重复参数要 @IsArray + 自定义 Transform
   * 才能稳定解析成数组，而管理端 UI 的角色筛选本来就是单选。
   * 真需要多选时再改成逗号分隔或重复参数。
   */
  @IsOptional()
  @IsEnum(RoleCode, { message: '角色编码不正确' })
  roleCode?: RoleCode;

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
