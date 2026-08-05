import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type {
  CancelGovernanceJobDto,
  CreateCleanupGovernanceJobDto,
  CreateRestoreGovernanceJobDto,
  DecideGovernanceJobDto,
  ExecuteGovernanceJobDto
} from './data-governance.types';
import { IdBusinessV2DataGovernanceApprovalService } from './id-business-v2-data-governance-approval.service';
import { IdBusinessV2DataGovernanceExecutionService } from './id-business-v2-data-governance-execution.service';
import { IdBusinessV2DataGovernancePreviewService } from './id-business-v2-data-governance-preview.service';
import { IdBusinessV2DataGovernanceQueryService } from './id-business-v2-data-governance-query.service';
import { IdBusinessV2DataGovernanceService } from './id-business-v2-data-governance.service';

interface RequestWithCommandMeta {
  requestId?: string;
}

@Controller('id-business-v2/data-governance')
@RequireRoles('admin')
export class IdBusinessV2DataGovernanceController {
  constructor(
    private readonly dataGovernanceService: IdBusinessV2DataGovernanceService,
    private readonly queryService: IdBusinessV2DataGovernanceQueryService,
    private readonly previewService: IdBusinessV2DataGovernancePreviewService,
    private readonly approvalService: IdBusinessV2DataGovernanceApprovalService,
    private readonly executionService: IdBusinessV2DataGovernanceExecutionService
  ) {}

  @Get('overview')
  overview(@CurrentUser() operator: AuthenticatedUser | undefined) {
    return this.dataGovernanceService.overview(operator);
  }

  @Get('recycle-bin')
  recycleBin(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('entity') entity?: string
  ) {
    return this.queryService.recycleBin({ page, pageSize, entity });
  }

  @Get('jobs')
  jobs(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('type') type?: string,
    @Query('status') status?: string
  ) {
    return this.queryService.jobs({ page, pageSize, type, status });
  }

  @Get('jobs/:id')
  job(@Param('id') id: string) {
    return this.queryService.job(id);
  }

  @Post('restore-jobs/preview')
  previewRestore(
    @Body() dto: CreateRestoreGovernanceJobDto,
    @CurrentUser() operator: AuthenticatedUser | undefined,
    @Req() request?: RequestWithCommandMeta
  ) {
    return this.previewService.createRestoreJob(dto, operator, { requestId: request?.requestId });
  }

  @Post('cleanup-jobs/preview')
  previewCleanup(
    @Body() dto: CreateCleanupGovernanceJobDto,
    @CurrentUser() operator: AuthenticatedUser | undefined,
    @Req() request?: RequestWithCommandMeta
  ) {
    return this.previewService.createCleanupJob(dto, operator, { requestId: request?.requestId });
  }

  @Post('jobs/:id/decision')
  decide(
    @Param('id') id: string,
    @Body() dto: DecideGovernanceJobDto,
    @CurrentUser() operator: AuthenticatedUser | undefined,
    @Req() request?: RequestWithCommandMeta
  ) {
    return this.approvalService.decide(id, dto, operator, { requestId: request?.requestId });
  }

  @Post('jobs/:id/cancel')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelGovernanceJobDto,
    @CurrentUser() operator: AuthenticatedUser | undefined,
    @Req() request?: RequestWithCommandMeta
  ) {
    return this.approvalService.cancel(id, dto, operator, { requestId: request?.requestId });
  }

  @Post('jobs/:id/execute')
  execute(
    @Param('id') id: string,
    @Body() dto: ExecuteGovernanceJobDto,
    @CurrentUser() operator: AuthenticatedUser | undefined,
    @Req() request?: RequestWithCommandMeta
  ) {
    return this.executionService.execute(id, dto, operator, { requestId: request?.requestId });
  }
}
