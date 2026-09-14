import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DocumentModule } from './document/document.module.js';
import { MqModule } from './mq/mq.module.js';
import { StorageModule } from './storage/storage.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // PostgreSQL：关系型数据（用户、权限、文档元数据等）
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): TypeOrmModuleOptions => ({
        type: 'postgres',
        host: config.get('POSTGRES_HOST', 'localhost'),
        port: Number(config.get('POSTGRES_PORT', 5432)),
        username: config.get('POSTGRES_USER', 'user'),
        password: config.get('POSTGRES_PASSWORD', '123456'),
        database: config.get('POSTGRES_DB', 'knowledge_hub'),
        // 实体通过 TypeOrmModule.forFeature() 注册，这里自动收集，无需手写 entities 列表
        autoLoadEntities: true,
        // 生产环境必须走 migration，禁止自动改表结构
        synchronize: config.get('DB_SYNCHRONIZE', config.get('NODE_ENV') !== 'production'),
        logging: config.get('NODE_ENV') === 'production' ? ['error'] : ['error', 'warn'],
      }),
    }),

    // MongoDB：非结构化数据（文档原文、切片、对话记录等）
    // 注意 authSource=admin，docker-compose 里的 root 账号建在 admin 库上
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get(
          'MONGODB_URI',
          'mongodb://mongo_user:mongo_pass123@localhost:27017/knowledge_hub?authSource=admin',
        ),
      }),
    }),

    // RustFS 文件存储（@Global，注册一次即可全局注入）
    StorageModule,

    // RabbitMQ 异步管线：发布后 RAG 索引（@Global，注册一次即可全局注入）
    MqModule,

    DocumentModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
