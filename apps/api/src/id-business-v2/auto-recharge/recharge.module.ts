import { Module } from '@nestjs/common';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { RechargeController } from './recharge.controller';
import { RechargeService } from './recharge.service';
@Module({
  imports: [IdBusinessV2RuntimeModule],
  controllers: [RechargeController],
  providers: [RechargeService, RechargeRepository, RechargeAddressRepository]
})
export class RechargeModule {}
