import { Body, Controller, Get, Header, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type {
  CreateIdBusinessV2ManagedMailboxDto,
  CreateIdBusinessV2ManagedMailboxBatchDto,
  ListIdBusinessV2ManagedMailboxesDto,
  StartIdBusinessV2MicrosoftMailboxAuthorizationDto,
  UpdateIdBusinessV2ManagedMailboxCredentialDto,
  UpdateIdBusinessV2ManagedMailboxQueryCodeSettingsDto,
  UpdateIdBusinessV2ManagedMailboxStatusDto
} from './dto/id-business-v2-managed-mailbox.dto';
import { IdBusinessV2ManagedMailboxSettingsService } from './id-business-v2-managed-mailbox-settings.service';
import { IdBusinessV2ManagedMailboxService } from './id-business-v2-managed-mailbox.service';
import { IdBusinessV2MicrosoftMailboxAuthorizationService } from './id-business-v2-microsoft-mailbox-authorization.service';

@RequireRoles('admin')
@Controller('id-business-v2/workspace-mailboxes')
export class IdBusinessV2ManagedMailboxController {
  constructor(
    private readonly service: IdBusinessV2ManagedMailboxService,
    private readonly settings: IdBusinessV2ManagedMailboxSettingsService,
    private readonly microsoftAuthorization: IdBusinessV2MicrosoftMailboxAuthorizationService
  ) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(
    @Query() query: ListIdBusinessV2ManagedMailboxesDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.service.list(query, operator);
  }

  @Post()
  @Header('Cache-Control', 'private, no-store')
  create(
    @Body() dto: CreateIdBusinessV2ManagedMailboxDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.create(dto, operator, request?.requestId);
  }

  @Post('batch')
  @Header('Cache-Control', 'private, no-store')
  createBatch(
    @Body() dto: CreateIdBusinessV2ManagedMailboxBatchDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.createBatch(dto, operator, request?.requestId);
  }

  @Post('microsoft/authorizations')
  @Header('Cache-Control', 'private, no-store')
  startMicrosoftAuthorization(
    @Body() dto: StartIdBusinessV2MicrosoftMailboxAuthorizationDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.microsoftAuthorization.start(dto, operator);
  }

  @Get('microsoft/authorizations/:authorizationId')
  @Header('Cache-Control', 'private, no-store')
  getMicrosoftAuthorizationStatus(
    @Param('authorizationId') authorizationId: string,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.microsoftAuthorization.getStatus(authorizationId, operator);
  }

  @Get('query-code-settings')
  @Header('Cache-Control', 'private, no-store')
  getQueryCodeSettings(@CurrentUser() operator?: AuthenticatedUser) {
    return this.settings.getSettings(operator);
  }

  @Patch('query-code-settings')
  @Header('Cache-Control', 'private, no-store')
  updateQueryCodeSettings(
    @Body() dto: UpdateIdBusinessV2ManagedMailboxQueryCodeSettingsDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.settings.updateSettings(dto, operator, request?.requestId);
  }

  @Patch(':mailboxId/status')
  @Header('Cache-Control', 'private, no-store')
  updateStatus(
    @Param('mailboxId') mailboxId: string,
    @Body() dto: UpdateIdBusinessV2ManagedMailboxStatusDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.updateStatus(mailboxId, dto, operator, request?.requestId);
  }

  @Put(':mailboxId/credential')
  @Header('Cache-Control', 'private, no-store')
  updateCredential(
    @Param('mailboxId') mailboxId: string,
    @Body() dto: UpdateIdBusinessV2ManagedMailboxCredentialDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.updateCredential(mailboxId, dto, operator, request?.requestId);
  }

  @Post(':mailboxId/query-code')
  @Header('Cache-Control', 'private, no-store')
  rotateQueryCode(
    @Param('mailboxId') mailboxId: string,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.rotateQueryCode(mailboxId, operator, request?.requestId);
  }
}
