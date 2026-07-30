import { Module } from '@nestjs/common';
import { IdBusinessV2AccountsModule } from './accounts/public-api';
import { IdBusinessV2ActivationsModule } from './activations/public-api';
import { IdBusinessV2BalancesModule } from './balances/public-api';
import { IdBusinessV2ChangeSyncModule } from './change-sync/public-api';
import { IdBusinessV2CustomersModule } from './customers/public-api';
import { IdBusinessV2ExchangeRatesModule } from './exchange-rates/public-api';
import { IdBusinessV2FinanceModule } from './finance/public-api';
import { IdBusinessV2GiftCardsModule } from './gift-cards/public-api';
import { IdBusinessV2OptionsModule } from './options/public-api';
import { IdBusinessV2OrdersModule } from './orders/public-api';
import { IdBusinessV2RenewalsModule } from './renewals/public-api';
import { IdBusinessV2TopupSupplierFundsModule } from './topup-supplier-funds/public-api';

@Module({
  imports: [
    IdBusinessV2OptionsModule,
    IdBusinessV2ChangeSyncModule,
    IdBusinessV2ExchangeRatesModule,
    IdBusinessV2FinanceModule,
    IdBusinessV2CustomersModule,
    IdBusinessV2AccountsModule,
    IdBusinessV2ActivationsModule,
    IdBusinessV2BalancesModule,
    IdBusinessV2GiftCardsModule,
    IdBusinessV2TopupSupplierFundsModule,
    IdBusinessV2OrdersModule,
    IdBusinessV2RenewalsModule
  ],
  controllers: []
})
export class IdBusinessV2Module {}
