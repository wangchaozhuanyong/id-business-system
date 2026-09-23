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
import { BankRechargeController } from './bank-recharge.controller';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { BankRechargeOrderService } from './bank-recharge-order.service';
import { BankRechargeQueryRepository } from './persistence/bank-recharge-query.repository';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import { BankRechargeFinanceService } from './bank-recharge-finance.service';
import { IdBusinessV2FinanceModule } from '../finance/public-api';
@Module({
  imports: [IdBusinessV2RuntimeModule, IdBusinessV2FinanceModule],
  controllers: [RechargeController, BankRechargeController],
  providers: [
    FieldEncryptionService,
    BankRechargeAccountService,
    BankRechargeOrderService,
    BankRechargeQueryRepository,
    BankRechargeRepository,
    BankRechargeFinanceService,
    RechargeService,
    RechargeLocalService,
    RechargeSettingsService,
    RechargeRepository,
    RechargeAddressRepository,
    RechargeSettingsRepository
  ]
})
export class RechargeModule {}
