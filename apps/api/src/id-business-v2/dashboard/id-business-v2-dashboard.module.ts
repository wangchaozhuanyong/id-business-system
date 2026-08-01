import { Module } from '@nestjs/common';
import { IdBusinessV2DashboardController } from './id-business-v2-dashboard.controller';
import { IdBusinessV2DashboardService } from './id-business-v2-dashboard.service';
import { IdBusinessV2DashboardRepository } from './persistence/id-business-v2-dashboard.repository';

@Module({
  controllers: [IdBusinessV2DashboardController],
  providers: [IdBusinessV2DashboardRepository, IdBusinessV2DashboardService]
})
export class IdBusinessV2DashboardModule {}
