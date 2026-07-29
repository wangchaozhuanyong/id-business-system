import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2AccountsModule } from '../accounts/public-api';
import { IdBusinessV2BalancesModule } from '../balances/public-api';
import { IdBusinessV2ExchangeRatesModule } from '../exchange-rates/public-api';
import { IdBusinessV2OptionsModule } from '../options/public-api';
import { IdBusinessV2GiftCardCreditService } from './id-business-v2-gift-card-credit.service';
import { IdBusinessV2GiftCardRecordsService } from './id-business-v2-gift-card-records.service';
import { IdBusinessV2GiftCardReversalService } from './id-business-v2-gift-card-reversal.service';
import { IdBusinessV2GiftCardsController } from './id-business-v2-gift-cards.controller';

@Module({
  imports: [
    AuditLogsModule,
    IdBusinessV2AccountsModule,
    IdBusinessV2BalancesModule,
    IdBusinessV2ExchangeRatesModule,
    IdBusinessV2OptionsModule
  ],
  controllers: [IdBusinessV2GiftCardsController],
  providers: [
    FieldEncryptionService,
    IdBusinessV2GiftCardCreditService,
    IdBusinessV2GiftCardRecordsService,
    IdBusinessV2GiftCardReversalService
  ],
  exports: [IdBusinessV2GiftCardCreditService]
})
export class IdBusinessV2GiftCardsModule {}
