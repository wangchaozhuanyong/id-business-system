import { Module } from '@nestjs/common';
import { IdBusinessV2BusinessMonitoringController } from './id-business-v2-business-monitoring.controller';
import { IdBusinessV2BusinessMonitoringService } from './id-business-v2-business-monitoring.service';
import { IdBusinessV2BusinessMonitoringRepository } from './persistence/id-business-v2-business-monitoring.repository';

@Module({
  controllers: [IdBusinessV2BusinessMonitoringController],
  providers: [IdBusinessV2BusinessMonitoringRepository, IdBusinessV2BusinessMonitoringService]
})
export class IdBusinessV2BusinessMonitoringModule {}
