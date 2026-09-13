import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentService } from './document.service.js';
import { DocumentController } from './document.controller.js';
import { DocumentEntity } from './entities/document.entity.js';
import {
  DocumentContent,
  DocumentContentSchema,
} from './schemas/document-content.schema.js';

@Module({
  imports: [
    // Postgres 元数据实体：全局 autoLoadEntities 只收集这里注册过的实体，
    // 漏掉会报 EntityMetadataNotFoundError
    TypeOrmModule.forFeature([DocumentEntity]),
    MongooseModule.forFeature([
      { name: DocumentContent.name, schema: DocumentContentSchema },
    ]),
  ],
  controllers: [DocumentController],
  providers: [DocumentService],
  exports: [DocumentService],
})
export class DocumentModule {}