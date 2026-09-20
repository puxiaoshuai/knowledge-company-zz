import { Module } from '@nestjs/common';
import { TeamController } from './team.controller.js';
import { TeamService } from './team.service.js';

/**
 * 团队模块：团队 CRUD + 成员管理（仅管理员）。
 *
 * 不 imports 任何模块：EntityManager 来自全局 TypeOrmCoreModule，
 * 与 UserModule / PermissionModule 同理。团队是组织配置而非安全边界，
 * 不与鉴权发生依赖。
 */
@Module({
  controllers: [TeamController],
  providers: [TeamService],
})
export class TeamModule {}
