import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  DocumentContent,
  DocumentContentSchema,
} from '../document/schemas/document-content.schema';
import { ChunkingService } from './chunking.service';
import { EmbeddingService } from './embedding.service';
import { PipelineOrchestrator } from './pipeline.orchestrator';
import { VectorIndexService } from './vector-index.service';
import { SearchIndexService } from './search-index.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DocumentContent.name, schema: DocumentContentSchema },
    ]),
  ],
  providers: [
    ChunkingService,
    EmbeddingService,
    SearchIndexService,
    VectorIndexService,
    PipelineOrchestrator,
  ],
  exports: [PipelineOrchestrator, VectorIndexService, SearchIndexService],
})
export class PipelineModule {}
