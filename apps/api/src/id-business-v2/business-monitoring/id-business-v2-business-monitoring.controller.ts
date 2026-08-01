import { Controller, Get, Query } from '@nestjs/common';
import { RequireRoles } from '../../auth/auth.decorators';
import { IdBusinessV2BusinessMonitoringService } from './id-business-v2-business-monitoring.service';

@Controller('id-business-v2/business-monitoring')
@RequireRoles('admin')
export class IdBusinessV2BusinessMonitoringController {
  constructor(private readonly monitoringService: IdBusinessV2BusinessMonitoringService) {}

  @Get('findings')
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('severity') severity?: string,
    @Query('category') category?: string
  ) {
    return this.monitoringService.list({ page, pageSize, severity, category });
  }
}
