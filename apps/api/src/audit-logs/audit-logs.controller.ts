import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditLogsService } from './audit-logs.service';
import type { ExportAuditLogsInput } from './audit-logs.types';

@Controller('audit-logs')
@RequireRoles('admin')
export class AuditLogsController {
  constructor(private readonly auditLogsService: AuditLogsService) {}

  @Get()
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('module') module?: string,
    @Query('action') action?: string,
    @Query('operator') operator?: string,
    @Query('keyword') keyword?: string,
    @Query('createdFrom') createdFrom?: string,
    @Query('createdTo') createdTo?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @Query('activity') activity?: string
  ) {
    return this.auditLogsService.list({
      page,
      pageSize,
      module,
      action,
      operator,
      keyword,
      createdFrom,
      createdTo,
      sortBy,
      sortOrder,
      activity
    });
  }

  @Get('sensitive-access')
  listSensitiveAccess(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('module') module?: string,
    @Query('fieldName') fieldName?: string,
    @Query('operator') operator?: string,
    @Query('approved') approved?: string,
    @Query('keyword') keyword?: string,
    @Query('createdFrom') createdFrom?: string,
    @Query('createdTo') createdTo?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.auditLogsService.listSensitiveAccess({
      page,
      pageSize,
      module,
      fieldName,
      operator,
      approved,
      keyword,
      createdFrom,
      createdTo,
      sortBy,
      sortOrder
    });
  }

  @Post('export')
  export(@Body() input: ExportAuditLogsInput, @CurrentUser() operator?: AuthenticatedUser) {
    return this.auditLogsService.export(input, operator);
  }
}
