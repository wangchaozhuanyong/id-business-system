import { Module } from '@nestjs/common';
import { IdBusinessV2OptionsModule } from '../options/public-api';
import { IdBusinessV2TopupSupplierFundsModule } from '../topup-supplier-funds/public-api';
import { IdBusinessV2BalanceCalculatorService } from './id-business-v2-balance-calculator.service';
import { IdBusinessV2BalancesController } from './id-business-v2-balances.controller';
import { IdBusinessV2TopupWorkbenchService } from './id-business-v2-topup-workbench.service';

@Module({
  imports: [IdBusinessV2OptionsModule, IdBusinessV2TopupSupplierFundsModule],
  controllers: [IdBusinessV2BalancesController],
  providers: [IdBusinessV2BalanceCalculatorService, IdBusinessV2TopupWorkbenchService],
  exports: [IdBusinessV2BalanceCalculatorService]
})
export class IdBusinessV2BalancesModule {}
