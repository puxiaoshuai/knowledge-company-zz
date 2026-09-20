import { SetMetadata } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../constants/auth.constant.js';

/**
 * 标记路由无需登录。
 *
 * 全局 JwtAuthGuard 默认拒绝一切未携带有效令牌的请求，
 * 只有标注了 @Public() 的路由（登录 / 注册 / 刷新 / 登出 等）才会放行。
 * 可标注在方法或控制器上；方法上的标注覆盖控制器上的。
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
