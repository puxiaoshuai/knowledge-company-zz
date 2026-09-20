import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service.js';

/**
 * 邮件模块。
 *
 * 与 RedisModule / StorageModule 同样标 @Global()：无状态的横切基础设施，
 * 业务模块直接注入 MailService 即可。AppModule 仍须 import 本模块才会被实例化。
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
