import { Body, Controller, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { RegistrationJobsService } from './registration-jobs.service';
import { RegistrationNamesService } from './registration-names.service';
import { RegistrationMailboxesService } from './registration-mailboxes.service';

@Controller('id-business-v2/auto-registration')
@RequireRoles('admin')
export class RegistrationController {
  constructor(
    private readonly jobs: RegistrationJobsService,
    private readonly names: RegistrationNamesService,
    private readonly mailboxes: RegistrationMailboxesService
  ) {}
  @Get('mailboxes') @Header('Cache-Control', 'no-store') listMailboxes(
    @Query()
    query: { page?: string; pageSize?: string; keyword?: string; registrationStatus?: string },
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.mailboxes.list(query, operator);
  }
  @Post('mailboxes/:id/registered') @Header('Cache-Control', 'no-store') markRegistered(
    @Param('id') aliasId: string,
    @Body() value: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.mailboxes.markRegistered(aliasId, value, operator);
  }
  @Get('execution') @Header('Cache-Control', 'no-store') execution(
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.jobs.execution(operator);
  }
  @Get('options') @Header('Cache-Control', 'no-store') options(
    @Query()
    query: {
      q?: string;
      page?: string;
      proxySearch?: string;
      proxyPage?: string;
      nameSearch?: string;
      namePage?: string;
    },
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.jobs.options(query, operator);
  }
  @Get('names') listNames(
    @Query() query: { page?: string; pageSize?: string; keyword?: string; status?: string }
  ) {
    return this.names.list(query);
  }
  @Post('names') createName(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.names.write(null, value, operator);
  }
  @Patch('names/:id') updateName(
    @Param('id') nameId: string,
    @Body() value: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.names.write(nameId, value, operator);
  }
  @Post('names/import') importNames(
    @Body() value: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.names.import(value, operator);
  }
  @Get('jobs') @Header('Cache-Control', 'no-store') list(
    @Query() query: { page?: string; pageSize?: string; keyword?: string },
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.jobs.list(query, operator);
  }
  @Get('jobs/pending') @Header('Cache-Control', 'no-store') pending(
    @Query('mailboxAliasId') mailboxAliasId: string,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.jobs.pending(mailboxAliasId, operator);
  }
  @Get('jobs/:id') @Header('Cache-Control', 'no-store') get(
    @Param('id') jobId: string,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.jobs.get(jobId, operator);
  }
  @Post('jobs') create(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.jobs.create(value, operator);
  }
  @Post('jobs/:id/launch') @Header('Cache-Control', 'no-store') launch(
    @Param('id') jobId: string,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.jobs.launch(jobId, operator);
  }
  @Post('jobs/:id/code') @Header('Cache-Control', 'no-store') code(
    @Param('id') jobId: string,
    @Body() value: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.jobs.submitCode(jobId, value, operator);
  }
  @Post('jobs/:id/cancel') cancel(
    @Param('id') jobId: string,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.jobs.cancel(jobId, operator);
  }

  @Post('jobs/:id/resume') @Header('Cache-Control', 'no-store') resume(
    @Param('id') jobId: string,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.jobs.resume(jobId, operator);
  }
}
