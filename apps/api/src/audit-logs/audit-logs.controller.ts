import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../auth/auth.decorators';
import { AuditLogsService } from './audit-logs.service';

@Controller('audit-logs')
@RequirePermissions('audit_log.view')
export class AuditLogsController {
  constructor(private readonly auditLogsService: AuditLogsService) {}

  @Get()
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('module') module?: string,
    @Query('action') action?: string,
    @Query('userId') userId?: string,
    @Query('keyword') keyword?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.auditLogsService.list({
      page,
      pageSize,
      module,
      action,
      userId,
      keyword,
      sortBy,
      sortOrder
    });
  }
}
