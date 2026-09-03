import { Body, Controller, Get, Header, Param, Post, Put, Req } from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type {
  CreateIdBusinessV2RelayJobDto,
  LoginIdBusinessV2RelayCloudBridgeDto,
  SaveIdBusinessV2RelayGoogleOAuthDto
} from './dto/id-business-v2-relay-script.dto';
import { IdBusinessV2RelayScriptService } from './id-business-v2-relay-script.service';
import { IdBusinessV2RelayJobRunnerService } from './id-business-v2-relay-job-runner.service';

@RequireRoles('admin')
@Controller('id-business-v2/workspace-relay')
export class IdBusinessV2RelayScriptController {
  constructor(
    private readonly service: IdBusinessV2RelayScriptService,
    private readonly jobRunner: IdBusinessV2RelayJobRunnerService
  ) {}

  @Get('connection')
  @Header('Cache-Control', 'private, no-store')
  connection(@CurrentUser() operator?: AuthenticatedUser) {
    return this.service.getConnectionStatus(operator);
  }

  @Put('google-oauth')
  @Header('Cache-Control', 'private, no-store')
  saveGoogleOAuth(
    @Body() dto: SaveIdBusinessV2RelayGoogleOAuthDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.saveGoogleOAuth(dto, operator, request?.requestId);
  }

  @Post('google-oauth/authorizations')
  @Header('Cache-Control', 'private, no-store')
  startGoogleAuthorization(@CurrentUser() operator?: AuthenticatedUser) {
    return this.service.startGoogleAuthorization(operator);
  }

  @Post('cloudbridge/sessions')
  @Header('Cache-Control', 'private, no-store')
  loginCloudBridge(
    @Body() dto: LoginIdBusinessV2RelayCloudBridgeDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.loginCloudBridge(dto, operator, request?.requestId);
  }

  @Get('options')
  @Header('Cache-Control', 'private, no-store')
  options(@CurrentUser() operator?: AuthenticatedUser) {
    return this.service.getDeploymentOptions(operator);
  }

  @Get('jobs')
  @Header('Cache-Control', 'private, no-store')
  listJobs(@CurrentUser() operator?: AuthenticatedUser) {
    return this.service.listJobs(operator);
  }

  @Post('jobs')
  @Header('Cache-Control', 'private, no-store')
  createJob(
    @Body() dto: CreateIdBusinessV2RelayJobDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.createJob(dto, operator, request?.requestId);
  }

  @Post('jobs/:jobId/run')
  @Header('Cache-Control', 'private, no-store')
  runJob(
    @Param('jobId') jobId: string,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.jobRunner.runNextStep(jobId, operator, request?.requestId);
  }
}
