import { Body, Controller, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { RechargeNameService } from './recharge-name.service';

@Controller('id-business-v2/auto-recharge/names')
@RequireRoles('admin')
export class RechargeNameController {
  constructor(private readonly names: RechargeNameService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() query: { page?: string; pageSize?: string; keyword?: string; status?: string }) {
    return this.names.list(query);
  }
  @Post('import')
  import(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.names.import(value, operator);
  }
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() value: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.names.update(id, value, operator);
  }
  @Post('payment-card')
  @Header('Cache-Control', 'no-store')
  prepare(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.names.prepare(value, operator);
  }
  @Post('match')
  @Header('Cache-Control', 'no-store')
  match(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.names.match(value, operator);
  }
}
