import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { DisableMfaInput, VerifyMfaInput } from '../../security/security.service';
import { V2ProfileService } from './v2-profile.service';

@Controller('v2/profile')
export class V2ProfileController {
  constructor(private readonly profileService: V2ProfileService) {}

  @Get('bootstrap')
  bootstrap(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('authorization') authorization?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string
  ) {
    return this.profileService.bootstrap(user, this.getBearerToken(authorization), {
      page,
      pageSize
    });
  }

  @Get()
  getProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.profileService.getProfile(user.id);
  }

  @Get('sessions')
  listSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('authorization') authorization?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string
  ) {
    return this.profileService.listSessions(user, this.getBearerToken(authorization), {
      page,
      pageSize
    });
  }

  @Post('sessions/revoke-others')
  revokeOtherSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('authorization') authorization?: string
  ) {
    return this.profileService.revokeOtherSessions(user, this.getBearerToken(authorization));
  }

  @Post('sessions/:id/revoke')
  revokeSession(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('authorization') authorization?: string
  ) {
    return this.profileService.revokeSession(id, user, this.getBearerToken(authorization));
  }

  @Get('mfa/status')
  getMfaStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.profileService.getMfaStatus(user);
  }

  @Post('mfa/setup')
  setupMfa(@CurrentUser() user: AuthenticatedUser) {
    return this.profileService.setupMfa(user);
  }

  @Post('mfa/enable')
  enableMfa(@CurrentUser() user: AuthenticatedUser, @Body() input: VerifyMfaInput) {
    return this.profileService.enableMfa(user, input);
  }

  @Post('mfa/recovery-codes')
  regenerateMfaRecoveryCodes(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: VerifyMfaInput
  ) {
    return this.profileService.regenerateMfaRecoveryCodes(user, input);
  }

  @Post('mfa/disable')
  disableMfa(@CurrentUser() user: AuthenticatedUser, @Body() input: DisableMfaInput) {
    return this.profileService.disableMfa(user, input);
  }

  private getBearerToken(authorization?: string) {
    const [scheme, token] = authorization?.trim().split(/\s+/, 2) ?? [];
    return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
  }
}
