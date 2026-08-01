import { Module } from '@nestjs/common';
import { V2AuthModule } from '../../v2-auth/v2-auth.module';
import { IdBusinessV2SystemMonitoringController } from './id-business-v2-system-monitoring.controller';
import { IdBusinessV2SystemMonitoringService } from './id-business-v2-system-monitoring.service';
import { IdBusinessV2SystemMonitoringRepository } from './persistence/id-business-v2-system-monitoring.repository';

@Module({
  imports: [V2AuthModule],
  controllers: [IdBusinessV2SystemMonitoringController],
  providers: [IdBusinessV2SystemMonitoringRepository, IdBusinessV2SystemMonitoringService]
})
export class IdBusinessV2SystemMonitoringModule {}
