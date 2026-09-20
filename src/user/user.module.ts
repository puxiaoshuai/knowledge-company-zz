import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { UserController } from './user.controller.js';
import { UserService } from './user.service.js';

/**
 * 用户管理模块（仅管理员）
 *
 * 依赖 auth 模块的三样东西：
 * - `UserAccessorService`：角色加载与用户视图映射，保证 password 不外泄的那道关口只有一份；
 * - `TokenService`：权限变更 / 禁用 / 软删后立即吊销该用户全部令牌；
 * - `EmailVerificationService`：改邮箱时作废待用的激活 token。
 *
 * 依赖方向是**单向**的 UserModule → AuthModule。反过来（把这三个服务放 user 侧
 * 供 auth 使用）会形成循环依赖，所以共享件一律留在 auth 侧。
 *
 * 数据库相关无需在这里 imports：`TypeOrmModule.forRootAsync` 注册的
 * `TypeOrmCoreModule` 是 @Global() 的，@InjectEntityManager 直接可用；
 * RedisModule / MailModule 同样是 @Global()。
 */
@Module({
  imports: [AuthModule],
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
