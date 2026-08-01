import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type {
  AdjustIdBusinessV2SupplierWalletDto,
  BackfillIdBusinessV2FinanceHistoryDto,
  CloseIdBusinessV2GiftCardRefundDto,
  ConfirmIdBusinessV2FinanceHistoryDto,
  CreateIdBusinessV2FinanceAccountDto,
  CreateIdBusinessV2FinanceExpenseDto,
  CreateIdBusinessV2SupplierDepositDto,
  CreateIdBusinessV2SupplierRefundDto,
  CreateIdBusinessV2SupplierWalletDto,
  ManualIdBusinessV2FinanceFxRateDto,
  ReopenIdBusinessV2FinanceHistoryDto,
  ReopenIdBusinessV2FinancePeriodDto,
  ReverseIdBusinessV2FinanceJournalDto,
  UpdateIdBusinessV2FinanceAccountDto
} from './dto/id-business-v2-finance.dto';
import { IdBusinessV2FinanceAccountsService } from './id-business-v2-finance-accounts.service';
import { IdBusinessV2FinanceExpensesService } from './id-business-v2-finance-expenses.service';
import { IdBusinessV2FinanceFxService } from './id-business-v2-finance-fx.service';
import { IdBusinessV2FinanceGiftCardRefundsService } from './id-business-v2-finance-gift-card-refunds.service';
import { IdBusinessV2FinanceHistoryConfirmationService } from './id-business-v2-finance-history-confirmation.service';
import { IdBusinessV2FinanceHistoryPreviewService } from './id-business-v2-finance-history-preview.service';
import { IdBusinessV2FinanceHistoryService } from './id-business-v2-finance-history.service';
import {
  normalizeFinanceCurrency,
  normalizeFinanceDate,
  normalizeFinanceRate,
  normalizeFinanceText
} from './id-business-v2-finance-input';
import { IdBusinessV2FinanceJournalsService } from './id-business-v2-finance-journals.service';
import { IdBusinessV2FinancePeriodsService } from './id-business-v2-finance-periods.service';
import { IdBusinessV2FinanceReportsService } from './id-business-v2-finance-reports.service';
import { IdBusinessV2FinanceSupplierWalletsService } from './id-business-v2-finance-supplier-wallets.service';

@Controller('id-business-v2/finance')
@RequirePermissions('finance.view')
export class IdBusinessV2FinanceController {
  constructor(
    private readonly accountsService: IdBusinessV2FinanceAccountsService,
    private readonly supplierWalletsService: IdBusinessV2FinanceSupplierWalletsService,
    private readonly expensesService: IdBusinessV2FinanceExpensesService,
    private readonly journalsService: IdBusinessV2FinanceJournalsService,
    private readonly reportsService: IdBusinessV2FinanceReportsService,
    private readonly periodsService: IdBusinessV2FinancePeriodsService,
    private readonly fxService: IdBusinessV2FinanceFxService,
    private readonly giftCardRefundsService: IdBusinessV2FinanceGiftCardRefundsService,
    private readonly historyPreviewService: IdBusinessV2FinanceHistoryPreviewService,
    private readonly historyService: IdBusinessV2FinanceHistoryService,
    private readonly historyConfirmationService: IdBusinessV2FinanceHistoryConfirmationService
  ) {}

  @Get('accounts')
  listAccounts(@Query('currency') currency?: string, @Query('status') status?: string) {
    return this.accountsService.list(currency, status);
  }

  @Post('accounts')
  @RequirePermissions('finance.view', 'finance.manage')
  createAccount(
    @Body() dto: CreateIdBusinessV2FinanceAccountDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.accountsService.create(dto, operator);
  }

  @Patch('accounts/:id')
  @RequirePermissions('finance.view', 'finance.manage')
  updateAccount(
    @Param('id') id: string,
    @Body() dto: UpdateIdBusinessV2FinanceAccountDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.accountsService.update(id, dto, operator);
  }

  @Get('supplier-wallets')
  listSupplierWallets(
    @Query('currency') currency?: string,
    @Query('supplierOptionId') supplierOptionId?: string
  ) {
    return this.supplierWalletsService.list(currency, supplierOptionId);
  }

  @Post('supplier-wallets')
  @RequirePermissions('finance.view', 'finance.manage')
  createSupplierWallet(
    @Body() dto: CreateIdBusinessV2SupplierWalletDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.supplierWalletsService.create(dto, operator);
  }

  @Get('supplier-wallets/:id/ledger')
  supplierWalletLedger(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string
  ) {
    return this.supplierWalletsService.ledger(id, { page, pageSize });
  }

  @Post('supplier-wallets/:id/deposits')
  @RequirePermissions('finance.view', 'finance.post')
  supplierDeposit(
    @Param('id') id: string,
    @Body() dto: CreateIdBusinessV2SupplierDepositDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.supplierWalletsService.deposit(id, dto, operator);
  }

  @Post('supplier-wallets/:id/refunds')
  @RequirePermissions('finance.view', 'finance.post')
  supplierRefund(
    @Param('id') id: string,
    @Body() dto: CreateIdBusinessV2SupplierRefundDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.supplierWalletsService.refund(id, dto, operator);
  }

  @Post('supplier-wallets/:id/adjustments')
  @RequirePermissions('finance.view', 'finance.adjust')
  supplierAdjustment(
    @Param('id') id: string,
    @Body() dto: AdjustIdBusinessV2SupplierWalletDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.supplierWalletsService.adjust(id, dto, operator);
  }

  @Get('expenses')
  listExpenses(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('categoryOptionId') categoryOptionId?: string,
    @Query('financeAccountId') financeAccountId?: string,
    @Query('currency') currency?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string
  ) {
    return this.expensesService.list({
      page,
      pageSize,
      categoryOptionId,
      financeAccountId,
      currency,
      dateFrom,
      dateTo
    });
  }

  @Post('expenses')
  @RequirePermissions('finance.view', 'finance.post')
  createExpense(
    @Body() dto: CreateIdBusinessV2FinanceExpenseDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.expensesService.create(dto, operator);
  }

  @Get('journals')
  listJournals(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('journalType') journalType?: string,
    @Query('sourceType') sourceType?: string,
    @Query('sourceId') sourceId?: string,
    @Query('periodMonth') periodMonth?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('currency') currency?: string,
    @Query('supplierOptionId') supplierOptionId?: string,
    @Query('financeAccountId') financeAccountId?: string
  ) {
    return this.journalsService.list({
      page,
      pageSize,
      journalType,
      sourceType,
      sourceId,
      periodMonth,
      dateFrom,
      dateTo,
      currency,
      supplierOptionId,
      financeAccountId
    });
  }

  @Post('gift-card-refunds/:giftCardId/receive')
  @RequirePermissions('finance.view', 'finance.post')
  receiveGiftCardRefund(
    @Param('giftCardId') giftCardId: string,
    @Body() dto: CloseIdBusinessV2GiftCardRefundDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.giftCardRefundsService.receive(giftCardId, dto, operator);
  }

  @Post('gift-card-refunds/:giftCardId/write-off')
  @RequirePermissions('finance.view', 'finance.adjust')
  writeOffGiftCardRefund(
    @Param('giftCardId') giftCardId: string,
    @Body() dto: CloseIdBusinessV2GiftCardRefundDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.giftCardRefundsService.writeOff(giftCardId, dto, operator);
  }

  @Post('journals/:id/reverse')
  @RequirePermissions('finance.view', 'finance.adjust')
  reverseJournal(
    @Param('id') id: string,
    @Body() dto: ReverseIdBusinessV2FinanceJournalDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.journalsService.reverse(id, dto.reason, dto.idempotencyKey, operator);
  }

  @Get('reports/overview')
  overview(
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('currency') currency?: string,
    @Query('supplierOptionId') supplierOptionId?: string,
    @Query('journalType') journalType?: string,
    @Query('financeAccountId') financeAccountId?: string,
    @Query('settlementPlatformOptionId') settlementPlatformOptionId?: string
  ) {
    return this.reportsService.overview({
      dateFrom,
      dateTo,
      currency,
      supplierOptionId,
      journalType,
      financeAccountId,
      settlementPlatformOptionId
    });
  }

  @Get('reports/profit-loss')
  profitLoss(@Query('dateFrom') dateFrom?: string, @Query('dateTo') dateTo?: string) {
    return this.reportsService.profitLoss({ dateFrom, dateTo });
  }

  @Get('reports/currency-breakdown')
  currencyBreakdown(@Query('dateFrom') dateFrom?: string, @Query('dateTo') dateTo?: string) {
    return this.reportsService.currencyBreakdown({ dateFrom, dateTo });
  }

  @Get('reports/assets')
  assets() {
    return this.reportsService.assets();
  }

  @Get('reports/reconciliation')
  reconciliation(@Query('dateFrom') dateFrom?: string, @Query('dateTo') dateTo?: string) {
    return this.reportsService.reconciliation({ dateFrom, dateTo });
  }

  @Get('settings')
  settings() {
    return this.reportsService.getSettings();
  }

  @Get('history/backfill-preview')
  @RequirePermissions('finance.view', 'finance.manage')
  previewHistoryBackfill() {
    return this.historyPreviewService.preview();
  }

  @Post('history/backfill')
  @RequirePermissions('finance.view', 'finance.manage')
  backfillHistory(
    @Body() dto: BackfillIdBusinessV2FinanceHistoryDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.historyService.backfill(
      dto.previewFingerprint,
      normalizeFinanceDate(dto.previewAsOf, '预览截止时间'),
      operator
    );
  }

  @Post('history/confirm')
  @RequirePermissions('finance.view', 'finance.manage')
  confirmHistory(
    @Body() dto: ConfirmIdBusinessV2FinanceHistoryDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.historyConfirmationService.confirm(dto, operator);
  }

  @Get('history/confirmation-preview')
  @RequirePermissions('finance.view', 'finance.manage')
  previewHistoryConfirmation() {
    return this.historyConfirmationService.preview();
  }

  @Post('history/reopen-confirmation')
  @RequirePermissions('finance.view', 'finance.manage')
  reopenHistoryConfirmation(
    @Body() dto: ReopenIdBusinessV2FinanceHistoryDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.historyConfirmationService.reopen(dto.reason, operator);
  }

  @Get('fx-rates/latest')
  latestFxRates() {
    return this.fxService.listLatest();
  }

  @Post('fx-rates/manual')
  @RequirePermissions('finance.view', 'finance.adjust')
  createManualFxRate(
    @Body() dto: ManualIdBusinessV2FinanceFxRateDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    const currency = normalizeFinanceCurrency(dto.currency);
    const rate = normalizeFinanceRate(dto.rateToCny, currency);
    const businessDate = normalizeFinanceDate(`${dto.businessDate}T00:00:00.000Z`, '业务日期');
    const reason = normalizeFinanceText(dto.reason, '人工汇率原因', 500, true)!;
    const sourceReference = normalizeFinanceText(dto.sourceReference, '来源说明', 500);
    return this.fxService.createManual(
      currency,
      rate,
      businessDate,
      reason,
      sourceReference,
      operator
    );
  }

  @Get('periods')
  periods() {
    return this.periodsService.list();
  }

  @Post('periods/:month/close')
  @RequirePermissions('finance.view', 'finance.close')
  closePeriod(@Param('month') month: string, @CurrentUser() operator?: AuthenticatedUser) {
    return this.periodsService.close(month, operator);
  }

  @Post('periods/:month/reopen')
  @RequirePermissions('finance.view', 'finance.close')
  reopenPeriod(
    @Param('month') month: string,
    @Body() dto: ReopenIdBusinessV2FinancePeriodDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.periodsService.reopen(month, dto.reason, operator);
  }
}
