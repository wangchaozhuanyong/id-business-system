import { Module } from '@nestjs/common';
import { IdBusinessV2FinanceModule } from '../finance/public-api';
import { IdBusinessV2TopupSupplierFundsController } from './id-business-v2-topup-supplier-funds.controller';
import { IdBusinessV2TopupSupplierFundsQueryService } from './id-business-v2-topup-supplier-funds-query.service';
import { IdBusinessV2TopupSupplierFundsService } from './id-business-v2-topup-supplier-funds.service';
import { IdBusinessV2TopupSupplierGiftCardFundsService } from './id-business-v2-topup-supplier-gift-card-funds.service';
import { IdBusinessV2TopupSupplierReassignmentService } from './id-business-v2-topup-supplier-reassignment.service';

@Module({
  imports: [IdBusinessV2FinanceModule],
  controllers: [IdBusinessV2TopupSupplierFundsController],
  providers: [
    IdBusinessV2TopupSupplierFundsService,
    IdBusinessV2TopupSupplierFundsQueryService,
    IdBusinessV2TopupSupplierGiftCardFundsService,
    IdBusinessV2TopupSupplierReassignmentService
  ],
  exports: [
    IdBusinessV2TopupSupplierFundsService,
    IdBusinessV2TopupSupplierFundsQueryService,
    IdBusinessV2TopupSupplierGiftCardFundsService,
    IdBusinessV2TopupSupplierReassignmentService
  ]
})
export class IdBusinessV2TopupSupplierFundsModule {}
