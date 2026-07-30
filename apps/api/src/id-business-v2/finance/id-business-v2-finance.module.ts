import { Module } from '@nestjs/common';
import { IdBusinessV2FinanceAccountsService } from './id-business-v2-finance-accounts.service';
import { IdBusinessV2FinanceController } from './id-business-v2-finance.controller';
import { IdBusinessV2FinanceExpensesService } from './id-business-v2-finance-expenses.service';
import { IdBusinessV2FinanceFxService } from './id-business-v2-finance-fx.service';
import { IdBusinessV2FinanceGiftCardRefundsService } from './id-business-v2-finance-gift-card-refunds.service';
import { IdBusinessV2FinanceHistoryService } from './id-business-v2-finance-history.service';
import { IdBusinessV2FinanceJournalsService } from './id-business-v2-finance-journals.service';
import { IdBusinessV2FinancePeriodsService } from './id-business-v2-finance-periods.service';
import { IdBusinessV2FinancePostingService } from './id-business-v2-finance-posting.service';
import { IdBusinessV2FinanceReportsService } from './id-business-v2-finance-reports.service';
import { IdBusinessV2FinanceSupplierWalletsService } from './id-business-v2-finance-supplier-wallets.service';

@Module({
  controllers: [IdBusinessV2FinanceController],
  providers: [
    IdBusinessV2FinanceAccountsService,
    IdBusinessV2FinanceExpensesService,
    IdBusinessV2FinanceFxService,
    IdBusinessV2FinanceGiftCardRefundsService,
    IdBusinessV2FinanceHistoryService,
    IdBusinessV2FinanceJournalsService,
    IdBusinessV2FinancePeriodsService,
    IdBusinessV2FinancePostingService,
    IdBusinessV2FinanceReportsService,
    IdBusinessV2FinanceSupplierWalletsService
  ],
  exports: [IdBusinessV2FinanceFxService, IdBusinessV2FinancePostingService]
})
export class IdBusinessV2FinanceModule {}
