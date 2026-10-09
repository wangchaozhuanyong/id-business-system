import { Body, Controller, Get, Header, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { OnlineRechargeAdminService } from './admin.service';
import { OnlineRechargeSettingsService } from './settings.service';
import { OnlineRechargeArtifactsService } from './artifacts.service';
import { Query } from '@nestjs/common';

@Controller('id-business-v2/online-recharge/admin')
@RequirePermissions('id_business_v2.online_recharge.read')
export class OnlineRechargeAdminController {
  constructor(
    private readonly service: OnlineRechargeAdminService,
    private readonly settings: OnlineRechargeSettingsService,
    private readonly artifacts: OnlineRechargeArtifactsService
  ) {}
  @Get('overview') @Header('Cache-Control', 'no-store') overview() {
    return this.service.overview();
  }
  @Get('config') @Header('Cache-Control', 'no-store') config() {
    return this.settings.get();
  }
  @Patch('config')
  @RequirePermissions('id_business_v2.online_recharge.manage')
  updateConfig(@Body() input: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.settings.update(input, operator);
  }
  @Get('artifacts/:id')
  @Header('Cache-Control', 'no-store')
  download(@Param('id') artifactId: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.artifacts.download(artifactId, operator);
  }
  @Get(':section')
  @Header('Cache-Control', 'no-store')
  list(
    @Param('section') section: string,
    @Query() query: Record<string, unknown>,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.service.list(section, query, operator);
  }
  @Post(':section/:action')
  @Header('Cache-Control', 'no-store')
  action(
    @Param('section') section: string,
    @Param('action') action: string,
    @Body() input: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.service.action(section, action, input, operator);
  }
}
