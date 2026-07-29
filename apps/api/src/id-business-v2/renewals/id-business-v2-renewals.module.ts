import { Module } from '@nestjs/common';
import { IdBusinessV2ActivationsModule } from '../activations/public-api';
import { IdBusinessV2BalancesModule } from '../balances/public-api';
import { IdBusinessV2OrdersModule } from '../orders/public-api';
import { IdBusinessV2ManualRenewalService } from './id-business-v2-manual-renewal.service';
import { IdBusinessV2RenewalWarningService } from './id-business-v2-renewal-warning.service';
import { IdBusinessV2RenewalsController } from './id-business-v2-renewals.controller';
import { IdBusinessV2RenewalsService } from './id-business-v2-renewals.service';

@Module({
  imports: [IdBusinessV2ActivationsModule, IdBusinessV2BalancesModule, IdBusinessV2OrdersModule],
  controllers: [IdBusinessV2RenewalsController],
  providers: [
    IdBusinessV2RenewalsService,
    IdBusinessV2ManualRenewalService,
    IdBusinessV2RenewalWarningService
  ],
  exports: [
    IdBusinessV2RenewalsService,
    IdBusinessV2ManualRenewalService,
    IdBusinessV2RenewalWarningService
  ]
})
export class IdBusinessV2RenewalsModule {}
