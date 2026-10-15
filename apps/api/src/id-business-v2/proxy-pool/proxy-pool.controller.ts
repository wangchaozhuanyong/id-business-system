import {
  Body,
  ForbiddenException,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query
} from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { RechargeProxyService } from './proxy-pool.service';

@Controller('id-business-v2/proxy-pool')
@RequirePermissions('id_business_v2.online_recharge.read')
export class ProxyPoolController {
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
      sortOrder?: string;
      completeOnly?: string;
    }
  ) {
    return this.proxies.list(query);
  }

  @Get('countries')
  countries() {
    return this.proxies.countries();
  }

  @Get(':id')
  @RequirePermissions(
    'id_business_v2.online_recharge.read',
    'id_business_v2.online_recharge.sensitive'
  )
  @Header('Cache-Control', 'no-store')
  detail(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    if (
      !operator.roles.includes('admin') &&
      operator.sensitiveApprovalPermissionCodes?.includes(
        'id_business_v2.online_recharge.sensitive'
      )
    )
      throw new ForbiddenException('该角色查看代理凭据需要审批');
    return this.proxies.detail(id, operator);
  }

  @Post()
  @RequirePermissions(
    'id_business_v2.online_recharge.read',
    'id_business_v2.online_recharge.manage'
  )
  create(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.proxies.create(value, operator);
  }

  @Post('import')
  @RequirePermissions(
    'id_business_v2.online_recharge.read',
    'id_business_v2.online_recharge.manage'
  )
  importMany(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.proxies.importMany(value, operator, true);
  }

  @Patch(':id')
  @RequirePermissions(
    'id_business_v2.online_recharge.read',
    'id_business_v2.online_recharge.manage'
  )
  update(
    @Param('id') id: string,
    @Body() value: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.proxies.update(id, value, operator);
  }

  @Delete(':id')
  @RequirePermissions(
    'id_business_v2.online_recharge.read',
    'id_business_v2.online_recharge.manage'
  )
  delete(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.proxies.delete(id, operator);
  }
}
