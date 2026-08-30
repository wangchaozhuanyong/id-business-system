import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { TrustedClientIp } from '../../common/http/trusted-client-ip';
import {
  SecurityService,
  type DisableMfaInput,
  type SaveIpWhitelistInput,
  type UpdateMfaSettingsInput,
  type VerifyMfaInput
} from '../../security/security.service';

@Controller('v2/security')
@RequireRoles('admin')
export class V2SecurityController {
  constructor(private readonly securityService: SecurityService) {}

  @Get('bootstrap')
  async bootstrap(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('authorization') authorization?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string
  ) {
    const currentSessionIdentifier = this.getBearerToken(authorization);
    const [overview, loginLogs, sessions, mfaSettings, myMfaStatus, ipWhitelists] =
      await Promise.all([
        this.securityService.overview(),
        this.securityService.listLoginLogs({ page, pageSize }),
        this.securityService.listActiveSessions(
          { page, pageSize, revoked: 'false' },
          currentSessionIdentifier
        ),
        this.securityService.getMfaSettings(),
        this.securityService.getMyMfaStatus(user),
        this.securityService.listIpWhitelists({ page, pageSize })
      ]);

    return {
      overview,
      loginLogs,
      sessions,
      mfaSettings,
      myMfaStatus,
      ipWhitelists,
      generatedAt: new Date().toISOString()
    };
  }

  @Get('overview')
  overview() {
    return this.securityService.overview();
  }

  @Get('login-logs')
  listLoginLogs(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('status') status?: string,
    @Query('abnormal') abnormal?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.securityService.listLoginLogs({
      page,
      pageSize,
      keyword,
      status,
      abnormal,
      sortBy,
      sortOrder
    });
  }

  @Get('sessions')
  listSessions(
    @Headers('authorization') authorization?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('revoked') revoked?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.securityService.listActiveSessions(
      {
        page,
        pageSize,
        keyword,
        revoked,
        sortBy,
        sortOrder
      },
      this.getBearerToken(authorization)
    );
  }

  @Post('sessions/:id/revoke')
  revokeSession(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.securityService.revokeSession(id, operator);
  }

  @Get('mfa/settings')
  getMfaSettings() {
    return this.securityService.getMfaSettings();
  }

  @Patch('mfa/settings')
  updateMfaSettings(
    @Body() dto: UpdateMfaSettingsInput,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.securityService.updateMfaSettingsSafely(dto, operator);
  }

  @Get('mfa/my-status')
  getMyMfaStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.securityService.getMyMfaStatus(user);
  }

  @Post('mfa/my-setup')
  setupMyMfa(@CurrentUser() user: AuthenticatedUser) {
    return this.securityService.setupMyMfa(user);
  }

  @Post('mfa/my-enable')
  enableMyMfa(@Body() dto: VerifyMfaInput, @CurrentUser() user: AuthenticatedUser) {
    return this.securityService.enableMyMfa(user, dto);
  }

  @Post('mfa/my-recovery-codes')
  regenerateMyMfaRecoveryCodes(
    @Body() dto: VerifyMfaInput,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.securityService.regenerateMyMfaRecoveryCodes(user, dto);
  }

  @Post('mfa/my-disable')
  disableMyMfa(@Body() dto: DisableMfaInput, @CurrentUser() user: AuthenticatedUser) {
    return this.securityService.disableMyMfa(user, dto);
  }

  @Get('mfa/users')
  listMfaUsers(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string
  ) {
    return this.securityService.listMfaUsers({ page, pageSize, keyword });
  }

  @Post('mfa/users/:id/reset')
  resetUserMfa(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.securityService.resetUserMfaSafely(id, operator);
  }

  @Get('ip-whitelists')
  listIpWhitelists(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('scope') scope?: string,
    @Query('enabled') enabled?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.securityService.listIpWhitelists({
      page,
      pageSize,
      keyword,
      scope,
      enabled,
      sortBy,
      sortOrder
    });
  }

  @Post('ip-whitelists')
  createIpWhitelist(
    @Body() dto: SaveIpWhitelistInput,
    @CurrentUser() operator: AuthenticatedUser,
    @TrustedClientIp() requestIp?: string
  ) {
    return this.securityService.createIpWhitelistSafely(dto, operator, requestIp);
  }

  @Patch('ip-whitelists/:id')
  updateIpWhitelist(
    @Param('id') id: string,
    @Body() dto: SaveIpWhitelistInput,
    @CurrentUser() operator: AuthenticatedUser,
    @TrustedClientIp() requestIp?: string
  ) {
    return this.securityService.updateIpWhitelistSafely(id, dto, operator, requestIp);
  }

  @Delete('ip-whitelists/:id')
  removeIpWhitelist(
    @Param('id') id: string,
    @CurrentUser() operator: AuthenticatedUser,
    @TrustedClientIp() requestIp?: string,
    @Query('expectedUpdatedAt') expectedUpdatedAt?: string
  ) {
    return this.securityService.removeIpWhitelistSafely(id, operator, requestIp, expectedUpdatedAt);
  }

  private getBearerToken(authorization?: string) {
    const [scheme, token] = authorization?.trim().split(/\s+/, 2) ?? [];
    return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
  }
}
