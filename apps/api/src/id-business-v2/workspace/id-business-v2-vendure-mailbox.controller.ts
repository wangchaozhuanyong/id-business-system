import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req
} from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type {
  BatchCreateIdBusinessV2VendureMailboxAliasesDto,
  CreateIdBusinessV2VendureMailboxAliasDto,
  CreateIdBusinessV2VendureMailboxPrimaryDto,
  ListIdBusinessV2VendureMailboxDto,
  ReassignIdBusinessV2VendureMailboxMailDto,
  ReconcileIdBusinessV2VendureMailboxHistoryDto,
  UpdateIdBusinessV2VendureMailboxAliasDto,
  UpdateIdBusinessV2VendureMailboxPrimaryDto
} from './dto/id-business-v2-vendure-mailbox.dto';
import { IdBusinessV2VendureMailboxService } from './id-business-v2-vendure-mailbox.service';

@RequireRoles('admin')
@Controller('id-business-v2/vendure-mailboxes')
export class IdBusinessV2VendureMailboxController {
  constructor(private readonly service: IdBusinessV2VendureMailboxService) {}

  @Get('status')
  @Header('Cache-Control', 'private, no-store')
  status(@CurrentUser() operator?: AuthenticatedUser) {
    return this.service.status(operator);
  }

  @Get('primary-accounts')
  @Header('Cache-Control', 'private, no-store')
  listPrimary(
    @Query() query: ListIdBusinessV2VendureMailboxDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.service.listPrimary(query, operator);
  }

  @Post('primary-accounts')
  createPrimary(
    @Body() dto: CreateIdBusinessV2VendureMailboxPrimaryDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.createPrimary(dto, operator, request?.requestId);
  }

  @Patch('primary-accounts/:id')
  updatePrimary(
    @Param('id') id: string,
    @Body() dto: UpdateIdBusinessV2VendureMailboxPrimaryDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.updatePrimary(id, dto, operator, request?.requestId);
  }

  @Delete('primary-accounts/:id')
  deletePrimary(
    @Param('id') id: string,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.deletePrimary(id, operator, request?.requestId);
  }

  @Post('primary-accounts/:id/test')
  testPrimary(
    @Param('id') id: string,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.primaryAction(id, 'test', operator, request?.requestId);
  }

  @Post('primary-accounts/:id/sync')
  syncPrimary(
    @Param('id') id: string,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.primaryAction(id, 'sync', operator, request?.requestId);
  }

  @Post('primary-accounts/:id/reset-code')
  resetPrimaryCode(
    @Param('id') id: string,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.primaryAction(id, 'reset-code', operator, request?.requestId);
  }

  @Post('primary-accounts/:id/reconcile')
  reconcile(
    @Param('id') id: string,
    @Body() dto: ReconcileIdBusinessV2VendureMailboxHistoryDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.reconcile(id, dto.dryRun, operator, request?.requestId);
  }

  @Get('aliases')
  @Header('Cache-Control', 'private, no-store')
  listAliases(
    @Query() query: ListIdBusinessV2VendureMailboxDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.service.listAliases(query, operator);
  }

  @Post('aliases')
  createAlias(
    @Body() dto: CreateIdBusinessV2VendureMailboxAliasDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.createAlias(dto, operator, request?.requestId);
  }

  @Post('aliases/batch')
  batchCreateAliases(
    @Body() dto: BatchCreateIdBusinessV2VendureMailboxAliasesDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.batchCreateAliases(dto, operator, request?.requestId);
  }

  @Patch('aliases/:id')
  updateAlias(
    @Param('id') id: string,
    @Body() dto: UpdateIdBusinessV2VendureMailboxAliasDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.updateAlias(id, dto, operator, request?.requestId);
  }

  @Post('aliases/:id/reset-code')
  resetAliasCode(
    @Param('id') id: string,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.aliasAction(id, 'reset-code', operator, request?.requestId);
  }

  @Delete('aliases/:id')
  deleteAlias(
    @Param('id') id: string,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.aliasAction(id, 'delete', operator, request?.requestId);
  }

  @Get('mails')
  @Header('Cache-Control', 'private, no-store')
  listMails(
    @Query() query: ListIdBusinessV2VendureMailboxDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.service.listMails(query, operator);
  }

  @Post('mails/:id/reassign')
  reassignMail(
    @Param('id') id: string,
    @Body() dto: ReassignIdBusinessV2VendureMailboxMailDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.reassignMail(id, dto, operator, request?.requestId);
  }

  @Delete('mails/:id')
  deleteMail(
    @Param('id') id: string,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.service.deleteMail(id, operator, request?.requestId);
  }
}
