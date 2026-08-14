import { Module } from '@nestjs/common';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2FinanceModule } from '../finance/public-api';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2SensitiveAccessModule } from '../sensitive-access/public-api';
import { IdBusinessV2TopupSupplierFundsController } from './id-business-v2-topup-supplier-funds.controller';
import { IdBusinessV2TopupSupplierFundsQueryService } from './id-business-v2-topup-supplier-funds-query.service';
import { IdBusinessV2TopupSupplierFundsService } from './id-business-v2-topup-supplier-funds.service';
import { IdBusinessV2TopupSupplierGiftCardFundsService } from './id-business-v2-topup-supplier-gift-card-funds.service';
import { IdBusinessV2TopupSupplierReassignmentService } from './id-business-v2-topup-supplier-reassignment.service';
import { IdBusinessV2TopupSupplierAccountRepository } from './persistence/id-business-v2-topup-supplier-account.repository';
import { IdBusinessV2TopupSupplierCommandRepository } from './persistence/id-business-v2-topup-supplier-command.repository';
import { IdBusinessV2TopupSupplierQueryRepository } from './persistence/id-business-v2-topup-supplier-query.repository';

@Module({
  imports: [
    IdBusinessV2FinanceModule,
    IdBusinessV2RuntimeModule,
    IdBusinessV2SensitiveAccessModule
  ],
  controllers: [IdBusinessV2TopupSupplierFundsController],
  providers: [
    IdBusinessV2TopupSupplierFundsService,
    FieldEncryptionService,
    IdBusinessV2TopupSupplierFundsQueryService,
    IdBusinessV2TopupSupplierGiftCardFundsService,
    IdBusinessV2TopupSupplierReassignmentService,
    IdBusinessV2TopupSupplierAccountRepository,
    IdBusinessV2TopupSupplierCommandRepository,
    IdBusinessV2TopupSupplierQueryRepository
  ],
  exports: [
    IdBusinessV2TopupSupplierFundsService,
    IdBusinessV2TopupSupplierFundsQueryService,
    IdBusinessV2TopupSupplierGiftCardFundsService,
    IdBusinessV2TopupSupplierReassignmentService
  ]
})
export class IdBusinessV2TopupSupplierFundsModule {}
