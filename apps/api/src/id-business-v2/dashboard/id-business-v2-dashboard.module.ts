import { Module } from '@nestjs/common';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2SensitiveAccessModule } from '../sensitive-access/public-api';
import { IdBusinessV2DashboardController } from './id-business-v2-dashboard.controller';
import { IdBusinessV2DashboardService } from './id-business-v2-dashboard.service';
import { IdBusinessV2DashboardRepository } from './persistence/id-business-v2-dashboard.repository';

@Module({
  imports: [IdBusinessV2SensitiveAccessModule],
  controllers: [IdBusinessV2DashboardController],
  providers: [FieldEncryptionService, IdBusinessV2DashboardRepository, IdBusinessV2DashboardService]
})
export class IdBusinessV2DashboardModule {}
