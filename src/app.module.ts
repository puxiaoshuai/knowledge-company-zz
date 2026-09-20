import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { RefreshTokenEntity } from './auth/entities/refresh-token.entity';
import { RoleEntity } from './auth/entities/role.entity';
import { UserRoleEntity } from './auth/entities/user-role.entity';
import { UserEntity } from './auth/entities/user.entity';
import { DocumentModule } from './document/document.module';
import { DocumentEntity } from './document/entities/document.entity';
import { DocumentReviewEntity } from './document/entities/document-review.entity';
import { MailModule } from './mail/mail.module';
import { MqModule } from './mq/mq.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PipelineModule,
    MqModule,
    StorageModule,
    // @Global() 只免除「别的模块 import 你」，本模块仍必须在这里列出才会被实例化
    RedisModule,
    MailModule,
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('POSTGRES_HOST', 'localhost'),
        port: config.get<number>('POSTGRES_PORT', 5432),
        username: config.get<string>('POSTGRES_USER', 'user'),
        password: config.get<string>('POSTGRES_PASSWORD', '123456'),
        database: config.get<string>('POSTGRES_DB', 'knowledge_hub'),
        entities: [
          DocumentEntity,
          DocumentReviewEntity,
          UserEntity,
          RoleEntity,
          UserRoleEntity,
          RefreshTokenEntity,
        ],
        synchronize: false,
      }),
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>(
          'MONGO_URI',
          'mongodb://mongo_user:mongo_pass123@localhost:27017/knowledge_hub?authSource=admin',
        ),
      }),
    }),
    DocumentModule,
    AuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
