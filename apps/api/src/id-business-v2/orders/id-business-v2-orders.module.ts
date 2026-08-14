import { Module } from '@nestjs/common';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2BalancesModule } from '../balances/public-api';
import { IdBusinessV2FinanceModule } from '../finance/public-api';
import { IdBusinessV2OptionsModule } from '../options/public-api';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2SensitiveAccessModule } from '../sensitive-access/public-api';
import { IdBusinessV2OrderConsumptionService } from './id-business-v2-order-consumption.service';
import { IdBusinessV2OrderCompletionService } from './id-business-v2-order-completion.service';
import { IdBusinessV2OrderEntryService } from './id-business-v2-order-entry.service';
import { IdBusinessV2OrderLifecycleService } from './id-business-v2-order-lifecycle.service';
import { IdBusinessV2OrderLockService } from './id-business-v2-order-lock.service';
import { IdBusinessV2OrderMatchingService } from './id-business-v2-order-matching.service';
import { IdBusinessV2OrdersController } from './id-business-v2-orders.controller';
import { IdBusinessV2OrdersService } from './id-business-v2-orders.service';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';

@Module({
  imports: [
    IdBusinessV2BalancesModule,
    IdBusinessV2FinanceModule,
    IdBusinessV2OptionsModule,
    IdBusinessV2RuntimeModule,
    IdBusinessV2SensitiveAccessModule
  ],
  controllers: [IdBusinessV2OrdersController],
  providers: [
    FieldEncryptionService,
    IdBusinessV2OrdersRepository,
    IdBusinessV2OrdersService,
    IdBusinessV2OrderMatchingService,
    IdBusinessV2OrderLockService,
    IdBusinessV2OrderEntryService,
    IdBusinessV2OrderConsumptionService,
    IdBusinessV2OrderCompletionService,
    IdBusinessV2OrderLifecycleService
  ],
  exports: [
    IdBusinessV2OrdersService,
    IdBusinessV2OrderMatchingService,
    IdBusinessV2OrderLockService,
    IdBusinessV2OrderEntryService,
    IdBusinessV2OrderConsumptionService,
    IdBusinessV2OrderCompletionService,
    IdBusinessV2OrderLifecycleService
  ]
})
export class IdBusinessV2OrdersModule {}
