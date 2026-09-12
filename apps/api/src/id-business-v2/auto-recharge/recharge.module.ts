import { Module } from '@nestjs/common';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { RechargeController } from './recharge.controller';
import { RechargeService } from './recharge.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { RechargeLocalService } from './recharge-local.service';
import { RechargeSettingsService } from './recharge-settings.service';
import { RechargeSettingsRepository } from './persistence/recharge-settings.repository';
@Module({
  imports: [IdBusinessV2RuntimeModule],
  controllers: [RechargeController],
  providers: [
    FieldEncryptionService,
    RechargeService,
    RechargeLocalService,
    RechargeSettingsService,
    RechargeRepository,
    RechargeAddressRepository,
    RechargeSettingsRepository
  ]
})
export class RechargeModule {}
