import { Module } from '@nestjs/common';
import { IdBusinessV2AccountsModule } from './accounts/public-api';
import { IdBusinessV2ActivationsModule } from './activations/public-api';
import { IdBusinessV2BalancesModule } from './balances/public-api';
import { IdBusinessV2BrandingModule } from './branding/public-api';
import { IdBusinessV2BusinessMonitoringModule } from './business-monitoring/public-api';
import { IdBusinessV2ChangeSyncModule } from './change-sync/public-api';
import { IdBusinessV2CustomersModule } from './customers/public-api';
import { IdBusinessV2DataGovernanceModule } from './data-governance/public-api';
import { IdBusinessV2DashboardModule } from './dashboard/public-api';
import { IdBusinessV2ExchangeRatesModule } from './exchange-rates/public-api';
import { IdBusinessV2FinanceModule } from './finance/public-api';
import { IdBusinessV2GiftCardsModule } from './gift-cards/public-api';
import { IdBusinessV2OptionsModule } from './options/public-api';
import { IdBusinessV2OrdersModule } from './orders/public-api';
import { IdBusinessV2RenewalsModule } from './renewals/public-api';
import { IdBusinessV2SensitiveAccessModule } from './sensitive-access/public-api';
import { IdBusinessV2SystemMonitoringModule } from './system-monitoring/public-api';
import { IdBusinessV2TablePreferencesModule } from './table-preferences/public-api';
import { IdBusinessV2TopupSupplierFundsModule } from './topup-supplier-funds/public-api';

@Module({
  imports: [
    IdBusinessV2OptionsModule,
    IdBusinessV2BrandingModule,
    IdBusinessV2ChangeSyncModule,
    IdBusinessV2SensitiveAccessModule,
    IdBusinessV2TablePreferencesModule,
    IdBusinessV2ExchangeRatesModule,
    IdBusinessV2FinanceModule,
    IdBusinessV2CustomersModule,
    IdBusinessV2DataGovernanceModule,
    IdBusinessV2DashboardModule,
    IdBusinessV2AccountsModule,
    IdBusinessV2ActivationsModule,
    IdBusinessV2BalancesModule,
    IdBusinessV2BusinessMonitoringModule,
    IdBusinessV2GiftCardsModule,
    IdBusinessV2TopupSupplierFundsModule,
    IdBusinessV2OrdersModule,
    IdBusinessV2RenewalsModule,
    IdBusinessV2SystemMonitoringModule
  ],
  controllers: []
})
export class IdBusinessV2Module {}
