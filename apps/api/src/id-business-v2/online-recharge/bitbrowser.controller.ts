import { Body, Controller, Get, Header, Headers, Param, Post } from '@nestjs/common';
import { CurrentUser, Public, RequirePermissions } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { OnlineBitbrowserDeviceRepository } from './persistence/bitbrowser-device.repository';
import { OnlineBitbrowserPaymentRepository } from './persistence/bitbrowser-payment.repository';
import { OnlineBitbrowserConnectorService } from './bitbrowser-connector.service';
import { OnlineBitbrowserConnectionsRepository } from './persistence/bitbrowser-connections.repository';
import { object } from './validation';

@Controller('id-business-v2/online-recharge/admin/bitbrowser')
@RequirePermissions('id_business_v2.online_recharge.read')
export class OnlineBitbrowserAdminController {
  constructor(
    private readonly devices: OnlineBitbrowserDeviceRepository,
    private readonly payments: OnlineBitbrowserPaymentRepository,
    private readonly connections: OnlineBitbrowserConnectionsRepository
  ) {}
  @Get('device') @Header('Cache-Control', 'no-store') device() {
    return this.devices.summary();
  }
  @Get('devices') @Header('Cache-Control', 'no-store') list() {
    return this.devices.list();
  }
  @Get('device/:id/connection') @Header('Cache-Control', 'no-store') connection(
    @Param('id') id: string
  ) {
    return this.connections.read(id);
  }
  @Post('device/:id/connection')
  @RequirePermissions(
    'id_business_v2.online_recharge.read',
    'id_business_v2.online_recharge.manage'
  )
  saveConnection(
    @Param('id') id: string,
    @Body() value: unknown,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.connections.save(id, value, user);
  }
  @Post('device/pairing')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(
    'id_business_v2.online_recharge.read',
    'id_business_v2.online_recharge.manage'
  )
  pairing(@Body() input: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.devices.pairing(input, user);
  }
  @Post('device/revoke')
  @RequirePermissions(
    'id_business_v2.online_recharge.read',
    'id_business_v2.online_recharge.manage'
  )
  revoke(@CurrentUser() user: AuthenticatedUser, @Body() value: unknown) {
    return this.devices.revoke(user, object(value ?? {}).deviceId);
  }
  @Post('tasks/:id/resume')
  @RequirePermissions(
    'id_business_v2.online_recharge.read',
    'id_business_v2.online_recharge.manage'
  )
  resume(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.resume(id, user);
  }
  @Post('tasks/:id/confirm')
  @RequirePermissions(
    'id_business_v2.online_recharge.read',
    'id_business_v2.online_recharge.manage'
  )
  confirm(@Param('id') id: string, @Body() input: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.confirm(id, input, user);
  }
}

@Controller('id-business-v2/online-recharge/connector')
@Public()
export class OnlineBitbrowserConnectorController {
  constructor(
    private readonly devices: OnlineBitbrowserDeviceRepository,
    private readonly connector: OnlineBitbrowserConnectorService
  ) {}
  @Post('pair') @Header('Cache-Control', 'no-store') pair(@Body() input: unknown) {
    return this.devices.pair(input);
  }
  @Post('rpc') @Header('Cache-Control', 'no-store') rpc(
    @Headers('x-online-recharge-device-token') key: unknown,
    @Body() input: unknown
  ) {
    return this.connector.rpc(key, input);
  }
}
