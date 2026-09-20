import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service.js';

/**
 * Redis 缓存模块。
 *
 * 标 @Global() 是因为它是个无状态的横切基础设施（同 StorageModule / MqModule 的取舍），
 * 业务模块直接注入 RedisService 即可，不必在每个 module 的 imports 里重复列一遍。
 * 注意：@Global() 只免除「别人 import 你」，AppModule 仍然必须 import 本模块，否则不会被实例化。
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
