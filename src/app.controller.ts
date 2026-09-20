import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service.js';
import { Public } from './auth/decorators/public.decorator.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** 健康检查：不鉴权，方便探活 */
  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
