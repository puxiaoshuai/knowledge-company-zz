import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 修改密码请求（已登录，凭当前密码）。
 *
 * 刻意**不收 username / userId**：身份一律取自 @CurrentUser()（即 JWT 载荷）。
 * 收了就等于给出「已登录的普通用户改别人密码」的入口，而这是本接口唯一
 * 必须守住的红线（见 README「身份只从 JWT 取」）。
 *
 * 也刻意**不收 newPassword 的二次确认**：那是前端的表单校验，服务端比对
 * 两个字段只会多一种 400，对安全性毫无贡献。
 */
export class ChangePasswordDto {
  /**
   * 当前密码。
   *
   * 只设 MaxLength 不设 MinLength：这里做的是「比对」，不是「设定规则」。
   * 给旧密码加长度下限，会让历史遗留的短密码用户永远改不了密码。
   */
  @IsString()
  @IsNotEmpty({ message: '请输入当前密码' })
  @MaxLength(64, { message: '密码长度最多 64 位' })
  oldPassword: string;

  /**
   * 新密码。
   *
   * 约束与 RegisterDto.password / ResetPasswordDto.newPassword **逐字一致**
   * （6-64 位、不做 trim）。只要这里松一点，本接口就成了绕过注册密码策略的后门。
   */
  @IsString()
  @MinLength(6, { message: '密码长度至少 6 位' })
  @MaxLength(64, { message: '密码长度最多 64 位' })
  newPassword: string;
}
