import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { RestoreAuditFieldsDto } from './audit-field-restore.types';
import { IdBusinessV2AuditRestoreService } from './id-business-v2-audit-restore.service';

@Controller('audit-logs')
@RequireRoles('admin')
export class IdBusinessV2AuditRestoreController {
  constructor(private readonly restoreService: IdBusinessV2AuditRestoreService) {}

  @Get(':id/restore-preview')
  preview(@Param('id') id: string, @CurrentUser() operator?: AuthenticatedUser) {
    return this.restoreService.preview(id, operator);
  }

  @Post(':id/restore')
  restore(
    @Param('id') id: string,
    @Body() input: RestoreAuditFieldsDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string; ip?: string; headers?: { 'user-agent'?: string } }
  ) {
    return this.restoreService.restore(id, input, operator, {
      requestId: request?.requestId,
      ip: request?.ip,
      userAgent: request?.headers?.['user-agent']
    });
  }
}
