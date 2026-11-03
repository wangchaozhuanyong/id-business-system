import { Controller, Get, GoneException, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2SensitiveAccessService } from './id-business-v2-sensitive-access.service';

@Controller('id-business-v2/sensitive-access')
export class IdBusinessV2SensitiveAccessController {
  constructor(private readonly sensitiveAccessService: IdBusinessV2SensitiveAccessService) {}

  @Get('policies')
  listPolicies(@CurrentUser() operator?: AuthenticatedUser) {
    return this.sensitiveAccessService.listPolicies(operator);
  }

  @Get('requests')
  listMyRequests(
    @Query('module') module?: string,
    @Query('fieldName') fieldName?: string,
    @Query('objectType') objectType?: string,
    @Query('objectId') objectId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.sensitiveAccessService.listMyRequests(
      { module, fieldName, objectType, objectId, status, page, pageSize },
      operator
    );
  }

  @Post('requests')
  createRequest() {
    throw new GoneException('业务资料直接查看，查看申请功能已移除');
  }

  @Get('approvals/summary')
  @RequireRoles('admin')
  listPendingSummary(@CurrentUser() operator?: AuthenticatedUser) {
    return this.sensitiveAccessService.listPendingSummary(operator);
  }

  @Get('approvals')
  @RequireRoles('admin')
  listApprovals(
    @Query('module') module?: string,
    @Query('fieldName') fieldName?: string,
    @Query('objectType') objectType?: string,
    @Query('objectId') objectId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.sensitiveAccessService.listApprovals(
      { module, fieldName, objectType, objectId, status, page, pageSize },
      operator
    );
  }

  @Patch('approvals/:id')
  @RequireRoles('admin')
  decide() {
    throw new GoneException('业务资料直接查看，查看审批功能已移除');
  }
}
