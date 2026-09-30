import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { RechargeProxyService } from './recharge-proxy.service';

@Controller('id-business-v2/auto-recharge/proxies')
@RequireRoles('admin')
export class RechargeProxyController {
  constructor(private readonly proxies: RechargeProxyService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Query()
    query: {
      page?: string;
      pageSize?: string;
      keyword?: string;
      countryCode?: string;
      kind?: string;
      status?: string;
    }
  ) {
    return this.proxies.list(query);
  }

  @Get('countries')
  countries() {
    return this.proxies.countries();
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  detail(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.proxies.detail(id, operator);
  }

  @Post()
  create(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.proxies.create(value, operator);
  }

  @Post('import')
  importMany(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.proxies.importMany(value, operator);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() value: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.proxies.update(id, value, operator);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.proxies.delete(id, operator);
  }
}
