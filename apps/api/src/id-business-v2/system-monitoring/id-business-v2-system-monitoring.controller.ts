import { Controller, Get } from '@nestjs/common';
import { RequireRoles } from '../../auth/auth.decorators';
import { IdBusinessV2SystemMonitoringService } from './id-business-v2-system-monitoring.service';

@Controller('id-business-v2/system-monitoring')
@RequireRoles('admin')
export class IdBusinessV2SystemMonitoringController {
  constructor(private readonly systemMonitoringService: IdBusinessV2SystemMonitoringService) {}

  @Get('overview')
  overview() {
    return this.systemMonitoringService.overview();
  }
}
