import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2AccountsModule } from '../accounts/public-api';
import { IdBusinessV2BalancesModule } from '../balances/public-api';
import { IdBusinessV2ExchangeRatesModule } from '../exchange-rates/public-api';
import { IdBusinessV2FinanceModule } from '../finance/public-api';
import { IdBusinessV2OptionsModule } from '../options/public-api';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2TopupSupplierFundsModule } from '../topup-supplier-funds/public-api';
import { IdBusinessV2GiftCardCreditService } from './id-business-v2-gift-card-credit.service';
import { IdBusinessV2GiftCardRecordsService } from './id-business-v2-gift-card-records.service';
import { IdBusinessV2GiftCardReversalService } from './id-business-v2-gift-card-reversal.service';
import { IdBusinessV2GiftCardSensitiveService } from './id-business-v2-gift-card-sensitive.service';
import { IdBusinessV2GiftCardsController } from './id-business-v2-gift-cards.controller';
import { IdBusinessV2GiftCardsRepository } from './persistence/id-business-v2-gift-cards.repository';

@Module({
  imports: [
    AuditLogsModule,
    IdBusinessV2AccountsModule,
    IdBusinessV2BalancesModule,
    IdBusinessV2ExchangeRatesModule,
    IdBusinessV2FinanceModule,
    IdBusinessV2OptionsModule,
    IdBusinessV2RuntimeModule,
    IdBusinessV2TopupSupplierFundsModule
  ],
  controllers: [IdBusinessV2GiftCardsController],
  providers: [
    FieldEncryptionService,
    IdBusinessV2GiftCardsRepository,
    IdBusinessV2GiftCardCreditService,
    IdBusinessV2GiftCardRecordsService,
    IdBusinessV2GiftCardReversalService,
    IdBusinessV2GiftCardSensitiveService
  ],
  exports: [IdBusinessV2GiftCardCreditService]
})
export class IdBusinessV2GiftCardsModule {}
