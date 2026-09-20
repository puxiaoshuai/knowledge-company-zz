/** 元数据键：标记路由无需登录（见 @Public()） */
export const IS_PUBLIC_KEY = 'auth:isPublic';

/** 元数据键：标记路由所需角色（见 @Roles()） */
export const ROLES_KEY = 'auth:roles';

/** bcrypt 代价因子，与 init.sql 里测试账号的哈希保持一致 */
export const BCRYPT_ROUNDS = 10;

/** 邮箱激活相关的 Redis key 前缀，便于在 RedisInsight / SCAN 里一眼归拢 */
export const EMAIL_VERIFY_KEY_PREFIX = 'kh:email-verify';

/** 激活链接默认有效期（秒）。默认 24h：激活邮件常在几小时后才被点开，30min 会产生大量「链接已过期」 */
export const EMAIL_VERIFY_TOKEN_TTL_DEFAULT = 60 * 60 * 24;

/** 重发激活邮件的默认冷却（秒），防止把接口当成邮件轰炸器 */
export const EMAIL_VERIFY_RESEND_COOLDOWN_DEFAULT = 60;

/**
 * 对外错误 / 提示文案。
 *
 * 集中放这里是为了让代码与 `接口文档.md` 的消息表一一对应 —— 前端按文案做分支时，
 * 改文案必须同步改文档，散落在各 service 里就没人记得住。
 */
export const AuthMessage = {
  /** 403：密码正确但邮箱未激活 */
  EmailNotVerified: '邮箱未验证，请先点击激活邮件中的链接',
  /** 400：token 不存在 / 已过期 / 对应用户已不存在 */
  EmailVerifyLinkInvalid: '激活链接无效或已过期，请重新发送激活邮件',
  /** 400：注册时邮箱与已有账号重复 */
  EmailAlreadyRegistered: '邮箱已被注册',
  /** 200：激活成功 */
  EmailVerifySuccess: '邮箱激活成功，请登录',
  /** 200：重复点击激活链接 */
  EmailAlreadyVerified: '邮箱已激活，请直接登录',
  /** 201：注册受理（此时还没登录） */
  RegisterAccepted: '注册成功，请查收激活邮件完成邮箱验证',
  /**
   * 201：重发受理。
   * 措辞刻意写成「如果…」，因为响应**不区分**账号是否存在 / 是否已激活 ——
   * 区分了就等于提供一个「账号是否已激活」的公开枚举器。
   */
  ResendAccepted: '如果账号存在且未激活，激活邮件已发送，请查收',
} as const;
