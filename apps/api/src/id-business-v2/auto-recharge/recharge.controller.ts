import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query
} from '@nestjs/common';
import { CurrentUser, Public, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { RechargeService } from './recharge.service';
import { RechargeLocalService } from './recharge-local.service';
import { RechargeSettingsService } from './recharge-settings.service';

@Controller('id-business-v2/auto-recharge')
@RequireRoles('admin')
export class RechargeController {
  constructor(
    private readonly service: RechargeService,
    private readonly local: RechargeLocalService,
    private readonly settings: RechargeSettingsService
  ) {}
  @Get('bitbrowser-settings')
  @Header('Cache-Control', 'no-store')
  getBitBrowserSettings(@CurrentUser() operator: AuthenticatedUser) {
    return this.settings.get(operator);
  }
  @Put('bitbrowser-settings')
  updateBitBrowserSettings(@Body() input: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.settings.update(input, operator);
  }
  @Get('jobs')
  @Header('Cache-Control', 'no-store')
  list(@CurrentUser() operator: AuthenticatedUser) {
    return this.service.list(operator);
  }
  @Get('addresses')
  @Header('Cache-Control', 'no-store')
  listAddresses(@Query() query: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.service.listAddresses(query, operator);
  }
  @Post('addresses/import')
  importAddresses(@Body() input: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.service.importAddresses(input, operator);
  }
  @Patch('addresses/:id/status')
  updateAddressStatus(
    @Param('id') id: string,
    @Body() input: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.service.updateAddressStatus(id, input, operator);
  }
  @Post('jobs')
  start(@Body() input: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.service.start(input, operator);
  }
  @Post('jobs/bitbrowser')
  startBitBrowser(@Body() input: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.local.start(input, operator);
  }
  @Post('jobs/bitbrowser-recheck')
  recheckBitBrowser(@Body() input: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.local.recheck(input, operator);
  }
  @Post('jobs/:id/bitbrowser-cancel')
  cancelBitBrowser(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.local.cancel(id, operator);
  }
  @Post('jobs/:id/bitbrowser-unreceived')
  abandonUnreceivedBitBrowser(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.local.abandonUnreceived(id, operator);
  }
  @Post('jobs/:id/bitbrowser-access')
  bitBrowserAccess(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.local.access(id, operator);
  }
  @Post('jobs/:id/confirm')
  confirm(
    @Param('id') id: string,
    @Body('nonce') nonce: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.service.confirm(id, nonce, operator);
  }
  @Post('jobs/:id/details')
  submitDetails(
    @Param('id') id: string,
    @Body() input: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.service.submitDetails(id, input, operator);
  }
  @Post('jobs/:id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.service.cancel(id, operator);
  }
  @Public()
  @Post('local/:id')
  localCallback(
    @Param('id') id: string,
    @Headers('x-recharge-local') token: unknown,
    @Body() input: unknown
  ) {
    return this.local.callback(id, token, input);
  }
  @Public()
  @Post('internal/:id')
  callback(
    @Param('id') id: string,
    @Headers('x-recharge-worker') token: unknown,
    @Body() input: unknown
  ) {
    this.service.authorizeWorker(token);
    return this.service.callback(id, input);
  }
}
