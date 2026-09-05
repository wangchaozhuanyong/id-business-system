import { Body, Controller, Get, Header, Post, Query } from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { CheckIdBusinessV2WebsiteDto } from './dto/id-business-v2-website-monitor.dto';
import { IdBusinessV2WebsiteMonitorService } from './id-business-v2-website-monitor.service';
import { IdBusinessV2WebsiteAnalyticsService } from './id-business-v2-website-analytics.service';

@Controller('id-business-v2/workspace-website-monitor')
export class IdBusinessV2WebsiteMonitorController {
  constructor(
    private readonly service: IdBusinessV2WebsiteMonitorService,
    private readonly analytics: IdBusinessV2WebsiteAnalyticsService
  ) {}

  @Get('analytics')
  @RequireRoles('admin')
  @Header('Cache-Control', 'private, no-store')
  report(@Query('days') days: unknown, @CurrentUser() operator?: AuthenticatedUser) {
    return this.analytics.report(days, operator);
  }

  @Post('check')
  @Header('Cache-Control', 'private, no-store')
  check(@Body() dto: CheckIdBusinessV2WebsiteDto, @CurrentUser() operator?: AuthenticatedUser) {
    return this.service.check(dto, operator);
  }
}
