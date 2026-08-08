import { Module } from '@nestjs/common';
import { IdBusinessV2ExchangeRatesModule } from '../exchange-rates/public-api';
import { IdBusinessV2OptionsModule } from '../options/public-api';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2FinanceAccountsService } from './id-business-v2-finance-accounts.service';
import { IdBusinessV2FinanceController } from './id-business-v2-finance.controller';
import { IdBusinessV2FinanceExpensesService } from './id-business-v2-finance-expenses.service';
import { IdBusinessV2FinanceFxService } from './id-business-v2-finance-fx.service';
import { IdBusinessV2FinanceGiftCardRefundsService } from './id-business-v2-finance-gift-card-refunds.service';
import { IdBusinessV2FinanceHistoryConfirmationService } from './id-business-v2-finance-history-confirmation.service';
import { IdBusinessV2FinanceHistoryPreviewService } from './id-business-v2-finance-history-preview.service';
import { IdBusinessV2FinanceHistoryService } from './id-business-v2-finance-history.service';
import { IdBusinessV2FinanceJournalsService } from './id-business-v2-finance-journals.service';
import { IdBusinessV2FinancePeriodsService } from './id-business-v2-finance-periods.service';
import { IdBusinessV2FinancePostingService } from './id-business-v2-finance-posting.service';
import { IdBusinessV2FinanceReportsService } from './id-business-v2-finance-reports.service';
import { IdBusinessV2FinanceSupplierWalletsService } from './id-business-v2-finance-supplier-wallets.service';
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';
import { IdBusinessV2FinanceGiftCardRefundRepository } from './persistence/id-business-v2-finance-gift-card-refund.repository';
import { IdBusinessV2FinanceHistoryPreviewRepository } from './persistence/id-business-v2-finance-history-preview.repository';
import { IdBusinessV2FinanceHistoryCommandRepository } from './persistence/id-business-v2-finance-history-command.repository';
import { IdBusinessV2FinanceHistoryConfirmationRepository } from './persistence/id-business-v2-finance-history-confirmation.repository';
import { IdBusinessV2FinanceQueryRepository } from './persistence/id-business-v2-finance-query.repository';
import { IdBusinessV2FinanceReportRepository } from './persistence/id-business-v2-finance-report.repository';
import { IdBusinessV2FinanceSupplierWalletRepository } from './persistence/id-business-v2-finance-supplier-wallet.repository';

@Module({
  imports: [IdBusinessV2ExchangeRatesModule, IdBusinessV2OptionsModule, IdBusinessV2RuntimeModule],
  controllers: [IdBusinessV2FinanceController],
  providers: [
    IdBusinessV2FinanceAccountsService,
    IdBusinessV2FinanceExpensesService,
    IdBusinessV2FinanceFxService,
    IdBusinessV2FinanceGiftCardRefundsService,
    IdBusinessV2FinanceHistoryConfirmationService,
    IdBusinessV2FinanceHistoryPreviewService,
    IdBusinessV2FinanceHistoryService,
    IdBusinessV2FinanceJournalsService,
    IdBusinessV2FinancePeriodsService,
    IdBusinessV2FinancePostingService,
    IdBusinessV2FinanceReportsService,
    IdBusinessV2FinanceSupplierWalletsService,
    IdBusinessV2FinanceCommandRepository,
    IdBusinessV2FinanceGiftCardRefundRepository,
    IdBusinessV2FinanceHistoryCommandRepository,
    IdBusinessV2FinanceHistoryConfirmationRepository,
    IdBusinessV2FinanceHistoryPreviewRepository,
    IdBusinessV2FinanceQueryRepository,
    IdBusinessV2FinanceReportRepository,
    IdBusinessV2FinanceSupplierWalletRepository
  ],
  exports: [IdBusinessV2FinanceFxService, IdBusinessV2FinancePostingService]
})
export class IdBusinessV2FinanceModule {}
