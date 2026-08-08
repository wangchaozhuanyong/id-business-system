import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type {
  CreateIdBusinessV2SensitiveAccessRequestDto,
  DecideIdBusinessV2SensitiveAccessRequestDto
} from './dto/id-business-v2-sensitive-access.dto';
import { IdBusinessV2SensitiveAccessService } from './id-business-v2-sensitive-access.service';

interface RequestWithAuditMeta {
  ip?: string;
  requestId?: string;
  headers: Record<string, string | string[] | undefined>;
}

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
  createRequest(
    @Body() dto: CreateIdBusinessV2SensitiveAccessRequestDto,
    @CurrentUser() operator: AuthenticatedUser | undefined,
    @Req() request: RequestWithAuditMeta
  ) {
    return this.sensitiveAccessService.createRequest(dto, operator, this.requestMeta(request));
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
  decide(
    @Param('id') id: string,
    @Body() dto: DecideIdBusinessV2SensitiveAccessRequestDto,
    @CurrentUser() operator: AuthenticatedUser | undefined,
    @Req() request: RequestWithAuditMeta
  ) {
    return this.sensitiveAccessService.decide(id, dto, operator, this.requestMeta(request));
  }

  private requestMeta(request: RequestWithAuditMeta) {
    const userAgentValue = request.headers['user-agent'];
    return {
      requestId: request.requestId,
      ip: request.ip,
      userAgent: Array.isArray(userAgentValue) ? userAgentValue[0] : userAgentValue
    };
  }
}
