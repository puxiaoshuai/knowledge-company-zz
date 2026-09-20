import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MyPermissionController } from './my-permission.controller.js';
import { PermissionController } from './permission.controller.js';
import { PermissionResolverService } from './permission-resolver.service.js';
import { PermissionService } from './permission.service.js';
import { PermissionsGuard } from './guards/permissions.guard.js';

/**
 * 权限模块：权限 CRUD、角色/用户授权、运行时权限码校验。
 *
 * 这里注册的 APP_GUARD 是**全局**的（PermissionsGuard）。全局守卫按模块在
 * app.module.ts imports 数组里的出现顺序实例化执行，因此 PermissionModule
 * **必须排在 AuthModule 之后** —— 否则 PermissionsGuard 跑在 JwtAuthGuard
 * 前面拿不到 request.user，只能 fail-closed 全部 403。
 *
 * 不 imports 任何模块：EntityManager 来自全局 TypeOrmCoreModule（与 UserModule
 * 同理），也正因此与 AuthModule 之间没有依赖边，不存在循环依赖。
 *
 * exports PermissionResolverService 供后续模块复用授权谓词
 * （同一谓词绝不复制第二份，见该服务的说明）。
 */
@Module({
  controllers: [PermissionController, MyPermissionController],
  providers: [
    PermissionService,
    PermissionResolverService,
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [PermissionResolverService],
})
export class PermissionModule {}
