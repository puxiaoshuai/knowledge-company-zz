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

/** 找回密码相关的 Redis key 前缀，与 kh:email-verify 并列 */
export const PASSWORD_RESET_KEY_PREFIX = 'kh:password-reset';

/**
 * 验证码默认有效期（秒）。
 *
 * 与激活链接的 24h 不同，这里是 10min：验证码只有 6 位数字（10^6 空间），
 * 靠长度换安全是行不通的，只能靠「窗口短 + 试错次数封顶」来压低命中率。
 * 10 分钟对「切到邮箱复制验证码」这个动作也足够宽裕。
 */
export const PASSWORD_RESET_CODE_TTL_DEFAULT = 60 * 10;

/**
 * 单个验证码允许的试错次数。
 *
 * 5 次把单码命中率压到 5/10^6 —— 但**单靠这个上限是不够的**，因为验证码可以被无限重发，
 * 攻击者能靠「重发一次 ≈ 重置试错计数」把总次数刷成每天几千次，
 * 所以必须配合下面的小时配额一起看（见 README「找回密码」一节的取舍说明）。
 */
export const PASSWORD_RESET_MAX_ATTEMPTS_DEFAULT = 5;

/** 重发验证码的默认冷却（秒） */
export const PASSWORD_RESET_RESEND_COOLDOWN_DEFAULT = 60;

/**
 * 单个用户名每小时的验证码请求上限（滚动窗口，重发**不**重置计数）。
 *
 * 这是本功能真正的暴力破解闸门：只有 60 秒冷却时，攻击者可以「重发一次 → 试 5 次」循环，
 * 约 300 次/小时（≈7200 次/天），几个月就能在 10^6 空间里撞出正确验证码，
 * 同时向受害者邮箱灌进上千封邮件。压到 5 次/小时后，猜测速率锁死在 25 次/小时，
 * 命中概率过半需要以年计，邮件上限也降到 120 封/天。
 *
 * 代价是一个**有界**的 DoS：攻击者刷满配额能让该用户在一小时内找不回密码。
 * 这是刻意选的 —— 有界且用户可见，总好过不设限的爆破窗口。
 */
export const PASSWORD_RESET_MAX_REQUESTS_PER_HOUR_DEFAULT = 5;

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
  /**
   * 201：找回密码受理。
   * 与 ResendAccepted 同理，措辞刻意「如果…」—— 不区分账号是否存在 / 是否禁用 / 是否绑邮箱。
   */
  ForgotPasswordAccepted: '如果账号存在，验证码已发送至绑定邮箱，请查收',
  /**
   * 400：重置密码时验证码不对。
   *
   * **所有失败分支共用这一句**：没申请过 / 已过期 / 输入错误 / 试错超限 / 并发抢先。
   * 一旦按分支给出不同文案，这个接口立刻变成「该账号是否存在、是否绑了邮箱」的探测器。
   */
  ResetPasswordCodeInvalid: '验证码无效或已过期，请重新获取',
  /** 200：重置成功。不签发令牌，用户需用新密码重新登录 */
  ResetPasswordSuccess: '密码已重置，请用新密码登录',
} as const;
