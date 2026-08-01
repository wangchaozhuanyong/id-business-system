import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2DashboardService } from './id-business-v2-dashboard.service';

@Controller('id-business-v2/dashboard')
export class IdBusinessV2DashboardController {
  constructor(private readonly dashboardService: IdBusinessV2DashboardService) {}

  @Get('overview')
  overview(@CurrentUser() user?: AuthenticatedUser) {
    return this.dashboardService.overview(user);
  }
}
