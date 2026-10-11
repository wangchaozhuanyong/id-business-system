import { Body, Controller, Get, Header, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import type { ServerResponse } from 'node:http';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import type { WorkspaceRequest } from './auto-registration.service';
import { AppleMailboxesService } from './apple-mailboxes.service';

@Controller('id-business-v2/auto-registration/apple-mailboxes')
@RequireRoles('admin')
export class AppleMailboxesController {
  constructor(
    private readonly service: AppleMailboxesService,
    private readonly authGuard: JwtAuthGuard,
    private readonly permissionsGuard: PermissionsGuard
  ) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@Query() query: Record<string, unknown>, @CurrentUser() operator: AuthenticatedUser) {
    return this.service.list(query, operator);
  }

  @Get('candidates')
  @Header('Cache-Control', 'private, no-store')
  candidates(@CurrentUser() operator: AuthenticatedUser) {
    return this.service.candidates(operator);
  }

  @Post('mark')
  mark(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.service.mark(value, operator);
  }

  @Post('start')
  start(
    @Body() value: unknown,
    @CurrentUser() operator: AuthenticatedUser,
    @Req() request: WorkspaceRequest & { user?: AuthenticatedUser },
    @Res({ passthrough: true }) response: ServerResponse
  ) {
    const context = new ExecutionContextHost(
      [request, response],
      AppleMailboxesController,
      this.start
    );
    return this.service.start(value, operator, async () => {
      await this.authGuard.canActivate(context);
      return request.user?.id === operator.id && (await this.permissionsGuard.canActivate(context));
    });
  }

  @Get('tasks/:id')
  @Header('Cache-Control', 'private, no-store')
  task(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.service.task(id, operator);
  }

  @Post('batch')
  batch(
    @Body() value: unknown,
    @CurrentUser() operator: AuthenticatedUser,
    @Req() request: WorkspaceRequest & { user?: AuthenticatedUser },
    @Res({ passthrough: true }) response: ServerResponse
  ) {
    const context = new ExecutionContextHost(
      [request, response],
      AppleMailboxesController,
      this.batch
    );
    return this.service.batch(value, operator, async () => {
      await this.authGuard.canActivate(context);
      return request.user?.id === operator.id && (await this.permissionsGuard.canActivate(context));
    });
  }

  @Get('batches/:id')
  @Header('Cache-Control', 'private, no-store')
  batchTask(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.service.batchTask(id, operator);
  }

  @Post('batches/:id/cancel')
  cancelBatch(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.service.cancelBatch(id, operator);
  }

  @Post('tasks/:id/sync')
  sync(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.service.sync(id, operator);
  }

  @Post('tasks/:id/local-save')
  localSave(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.service.localSave(id, operator);
  }

  @Post('resume')
  resume(
    @CurrentUser() operator: AuthenticatedUser,
    @Req() request: WorkspaceRequest & { user?: AuthenticatedUser },
    @Res({ passthrough: true }) response: ServerResponse
  ) {
    const context = new ExecutionContextHost(
      [request, response],
      AppleMailboxesController,
      this.resume
    );
    return this.service.resume(operator, async () => {
      await this.authGuard.canActivate(context);
      return request.user?.id === operator.id && (await this.permissionsGuard.canActivate(context));
    });
  }

  @Post('tasks/:id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.service.cancel(id, operator);
  }

  @Post('recover')
  recover(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.service.recover(value, operator);
  }
}
