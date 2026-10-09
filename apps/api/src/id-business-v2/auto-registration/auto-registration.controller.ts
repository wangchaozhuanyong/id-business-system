import { All, Controller, Get, Headers, Post, Req, Res } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import type { ServerResponse } from 'node:http';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { createRegistrationWorkspaceSession } from '../../auth/registration-workspace-session';
import { SkipApiResponse } from '../../common/interceptors/skip-api-response.decorator';
import { AutoRegistrationService, type WorkspaceRequest } from './auto-registration.service';

@Controller('id-business-v2/auto-registration')
@RequireRoles('admin')
export class AutoRegistrationController {
  constructor(
    private readonly service: AutoRegistrationService,
    private readonly authGuard: JwtAuthGuard,
    private readonly permissionsGuard: PermissionsGuard
  ) {}

  @Get('status')
  status() {
    return this.service.status();
  }

  @Post('workspace-session')
  async workspaceSession(
    @Headers('authorization') authorization: string,
    @CurrentUser() operator: AuthenticatedUser,
    @Req() request: WorkspaceRequest,
    @Res({ passthrough: true }) response: ServerResponse
  ) {
    await this.service.status();
    return createRegistrationWorkspaceSession(
      response,
      authorization.slice('Bearer '.length),
      operator.id,
      request
    );
  }

  @All('workspace/{*path}')
  @SkipApiResponse()
  workspace(
    @Req() request: WorkspaceRequest,
    @Res() response: ServerResponse,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    const context = new ExecutionContextHost(
      [request, response],
      AutoRegistrationController,
      this.workspace
    );
    const revalidate = async () => {
      await this.authGuard.canActivate(context);
      return this.permissionsGuard.canActivate(context);
    };
    return this.service.proxy(request, response, operator, revalidate);
  }
}
