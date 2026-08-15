import { Body, Controller, Get, Header, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type {
  CreateIdBusinessV2ManagedMailboxDto,
  ListIdBusinessV2ManagedMailboxesDto,
  UpdateIdBusinessV2ManagedMailboxCredentialDto,
  UpdateIdBusinessV2ManagedMailboxStatusDto
} from './dto/id-business-v2-managed-mailbox.dto';
import { IdBusinessV2ManagedMailboxService } from './id-business-v2-managed-mailbox.service';

@RequireRoles('admin')
@Controller('id-business-v2/workspace-mailboxes')
export class IdBusinessV2ManagedMailboxController {
  constructor(private readonly service: IdBusinessV2ManagedMailboxService) {}

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

  @Patch(':mailboxId/status')
  updateStatus(
    @Param('mailboxId') mailboxId: string,
    @Body() dto: UpdateIdBusinessV2ManagedMailboxStatusDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.updateStatus(mailboxId, dto, operator, request?.requestId);
  }

  @Put(':mailboxId/credential')
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
