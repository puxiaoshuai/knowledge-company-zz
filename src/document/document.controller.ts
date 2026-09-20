import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RoleCode } from '../auth/constants/role.constant.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type.js';
import { DocumentService } from './document.service';
import { DocumentReviewService } from './document-review.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { QueryDocumentDto } from './dto/query-document.dto';
import { UploadParseDto } from './dto/upload-parse.dto';
import { QueryReviewTasksDto, ReviewDecisionDto } from './dto/review.dto';

/**
 * 文档接口
 *
 * 全部路由都需要登录（全局 JwtAuthGuard 默认拒绝）。
 * 审核类接口额外限制 ROLE_ADMIN / ROLE_REVIEWER，归档与删除限制 ROLE_ADMIN。
 * 作者 / 创建人 / 更新人 / 审核人一律取自 JWT，不读请求体。
 */
@Controller('documents')
export class DocumentController {
  constructor(
    private readonly documentService: DocumentService,
    private readonly reviewService: DocumentReviewService,
  ) {}

  /** 创建文档（作者与创建人取自当前登录用户） */
  @Post()
  create(
    @Body() dto: CreateDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentService.create(dto, user.id);
  }

  /** 上传文件并解析为 Markdown，创建草稿（form-data 字段名: file） */
  @Post('upload/parse')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  uploadAndParse(
    @UploadedFile() file: Express.Multer.File,
    @Body() meta: UploadParseDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!file) {
      throw new BadRequestException('请上传文件（form-data 字段名: file）');
    }
    return this.documentService.uploadAndCreateDocument(file, user.id, meta);
  }

  /** 审核待办列表（须在 @Get(':id') 之前注册，避免路由被 :id 吃掉） */
  @Roles(RoleCode.Admin, RoleCode.Reviewer)
  @Get('reviews/tasks')
  listReviewTasks(@Query() query: QueryReviewTasksDto) {
    return this.reviewService.listTasks(query);
  }

  /** 待审核数量（导航角标等） */
  @Roles(RoleCode.Admin, RoleCode.Reviewer)
  @Get('reviews/tasks/pending-count')
  pendingReviewCount() {
    return this.reviewService.getPendingCount();
  }

  /** 分页查询文档列表（仅元数据） */
  @Get()
  findAll(@Query() query: QueryDocumentDto) {
    return this.documentService.findAll(query);
  }

  /** 发布文档（需审核时进入待审；免审则直接发布并投递 MQ） */
  @Put(':id/publish')
  publish(@Param('id') id: string) {
    return this.documentService.publish(id);
  }

  /** 归档：Published → Archived，并清 RAG/Search/KG 索引 */
  @Roles(RoleCode.Admin)
  @Put(':id/archive')
  archive(@Param('id') id: string) {
    return this.documentService.archive(id);
  }

  /** 下架编辑：Published → Draft，清索引后可改内容再提审/发布 */
  @Put(':id/save-draft')
  saveAsDraft(@Param('id') id: string) {
    return this.documentService.saveAsDraft(id);
  }

  /** 单独提交审核（也可由 publish 在需审核时内部调用） */
  @Post(':id/reviews/submit')
  submitReview(@Param('id') id: string) {
    return this.reviewService.submitForReview(id);
  }

  /** 当前待审记录（review_result IS NULL） */
  @Get(':id/reviews/current')
  getCurrentReview(@Param('id') id: string) {
    return this.reviewService.getCurrentReview(id);
  }

  /** 该文档全部审核历史，按 created_at 倒序 */
  @Get(':id/reviews/history')
  getReviewHistory(@Param('id') id: string) {
    return this.reviewService.getReviewHistory(id);
  }

  /** 审核通过 → 文档 Published + 重建索引 */
  @Roles(RoleCode.Admin, RoleCode.Reviewer)
  @Post('reviews/tasks/:taskId/approve')
  approveReview(
    @Param('taskId') taskId: string,
    @Body() dto: ReviewDecisionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reviewService.approveReview(
      taskId,
      user.id,
      user.name,
      dto.reviewComment,
    );
  }

  /** 审核驳回 → 文档回 Draft，作者可修改后再次 submit */
  @Roles(RoleCode.Admin, RoleCode.Reviewer)
  @Post('reviews/tasks/:taskId/reject')
  rejectReview(
    @Param('taskId') taskId: string,
    @Body() dto: ReviewDecisionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reviewService.rejectReview(
      taskId,
      user.id,
      user.name,
      dto.reviewComment ?? '',
    );
  }

  /** 查询文档详情（含正文） */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.documentService.findOne(id);
  }

  /** 更新文档（更新人取自当前登录用户） */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentService.update(id, dto, user.id);
  }

  /** 软删除文档 */
  @Roles(RoleCode.Admin)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.documentService.remove(id);
  }
}
