import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * 先 trim 再去校验格式。
 *
 * class-transformer 的变换在校验之前执行，所以从别处复制粘贴带来的首尾空格
 * 会被先清掉，而不是让 `@IsEmail` 报一句其实并不准确的「邮箱格式不正确」。
 * 大小写的归一放在 service 层（normalizeEmail），因为那关系到唯一索引的语义，
 * 属于业务规则而不是入参清洗。
 */
const trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/**
 * 注册请求
 *
 * 邮箱**必填**：它是邮箱激活的唯一通道，也是后续找回密码 / 改密的凭据。
 * 允许留空的话，账号既收不到激活邮件、email_verified 也永远不会变成 1，
 * 等于建了一个永远登录不了的死号。
 *
 * 不接受任何角色字段：新用户固定授予 ROLE_USER，
 * 多传字段会被全局 ValidationPipe 的 forbidNonWhitelisted 直接拒绝。
 */
export class RegisterDto {
  /** 登录用户名（3-50 位，仅字母 / 数字 / 下划线） */
  @IsString()
  @Matches(/^[a-zA-Z0-9_]{3,50}$/, {
    message: '用户名只能包含字母、数字、下划线，长度 3-50',
  })
  username: string;

  /** 密码（6-64 位） */
  @IsString()
  @MinLength(6, { message: '密码长度至少 6 位' })
  @MaxLength(64, { message: '密码长度最多 64 位' })
  password: string;

  /** 邮箱（服务端会 trim + 转小写后入库，小写形式才唯一） */
  @trim()
  @IsEmail({}, { message: '邮箱格式不正确' })
  @MaxLength(100, { message: '邮箱长度最多 100 位' })
  email: string;

  /** 真实姓名 / 显示名 */
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '姓名长度最多 50 位' })
  realName?: string;
}
