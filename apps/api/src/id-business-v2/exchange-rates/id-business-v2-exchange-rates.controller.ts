import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { CurrentUser, Public, RequirePermissions } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { CreateIdBusinessV2ExchangeRateEntryDto } from './dto/create-id-business-v2-exchange-rate-entry.dto';
import type { CreateIdBusinessV2ManualFxRateDto } from './dto/create-id-business-v2-manual-fx-rate.dto';
import type { UpdateIdBusinessV2ExchangeRateSettingsDto } from './dto/update-id-business-v2-exchange-rate-settings.dto';
import { IdBusinessV2ExchangeRateCronService } from './id-business-v2-exchange-rate-cron.service';
import { IdBusinessV2ExchangeRateQueryService } from './id-business-v2-exchange-rate-query.service';
import { IdBusinessV2ExchangeRateSettingsService } from './id-business-v2-exchange-rate-settings.service';
import { IdBusinessV2ExchangeRateWorker } from './id-business-v2-exchange-rate.worker';
import { IdBusinessV2ExchangeRatesService } from './id-business-v2-exchange-rates.service';

@Controller('id-business-v2/exchange-rates')
@RequirePermissions('apple.exchange_rate.view')
export class IdBusinessV2ExchangeRatesController {
  constructor(
    private readonly exchangeRatesService: IdBusinessV2ExchangeRatesService,
    private readonly queryService: IdBusinessV2ExchangeRateQueryService,
    private readonly settingsService: IdBusinessV2ExchangeRateSettingsService,
    private readonly worker: IdBusinessV2ExchangeRateWorker,
    private readonly cronService: IdBusinessV2ExchangeRateCronService
  ) {}

  @Post('cron')
  @Public()
  runCron(@Headers('authorization') authorization?: string) {
    return this.cronService.run(authorization);
  }

  @Get('bootstrap')
  async bootstrap(
    @Query('runPage') runPage?: string,
    @Query('runPageSize') runPageSize?: string,
    @Query('runKeyword') runKeyword?: string,
    @Query('runStatus') runStatus?: string,
    @Query('runTriggerType') runTriggerType?: string,
    @Query('runCollectedFrom') runCollectedFrom?: string,
    @Query('runCollectedTo') runCollectedTo?: string,
    @Query('recordPage') recordPage?: string,
    @Query('recordPageSize') recordPageSize?: string,
    @Query('recordCurrency') recordCurrency?: string,
    @Query('recordSource') recordSource?: string,
    @Query('recordStatus') recordStatus?: string,
    @Query('recordCapturedFrom') recordCapturedFrom?: string,
    @Query('recordCapturedTo') recordCapturedTo?: string,
    @Query('manualPage') manualPage?: string,
    @Query('manualPageSize') manualPageSize?: string,
    @Query('manualKeyword') manualKeyword?: string,
    @Query('manualCurrency') manualCurrency?: string,
    @Query('manualRecordedFrom') manualRecordedFrom?: string,
    @Query('manualRecordedTo') manualRecordedTo?: string
  ) {
    const [overview, runtime, runs, records, manualEntries] = await Promise.all([
      this.queryService.getOverview(),
      this.worker.getRuntime(),
      this.queryService.listRuns({
        page: runPage,
        pageSize: runPageSize,
        keyword: runKeyword,
        status: runStatus,
        triggerType: runTriggerType,
        collectedFrom: runCollectedFrom,
        collectedTo: runCollectedTo
      }),
      this.queryService.listRecords({
        page: recordPage,
        pageSize: recordPageSize,
        currency: recordCurrency,
        source: recordSource,
        status: recordStatus,
        capturedFrom: recordCapturedFrom,
        capturedTo: recordCapturedTo
      }),
      this.exchangeRatesService.listManualFxRates({
        page: manualPage,
        pageSize: manualPageSize,
        keyword: manualKeyword,
        currency: manualCurrency,
        recordedFrom: manualRecordedFrom,
        recordedTo: manualRecordedTo,
        sortOrder: 'desc'
      })
    ]);
    return {
      overview,
      runtime,
      runs,
      records,
      manualEntries,
      latestReceiptFxRates: overview.latestReceiptFxRates,
      generatedAt: new Date().toISOString()
    };
  }

  @Get()
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('recordedFrom') recordedFrom?: string,
    @Query('recordedTo') recordedTo?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.exchangeRatesService.list({
      page,
      pageSize,
      keyword,
      recordedFrom,
      recordedTo,
      sortBy,
      sortOrder
    });
  }

  @Get('overview')
  getOverview() {
    return this.queryService.getOverview();
  }

  @Get('runtime')
  getRuntime() {
    return this.worker.getRuntime();
  }

  @Get('effective')
  getEffective() {
    return this.queryService.getEffective();
  }

  @Get('records')
  listRecords(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('currency') currency?: string,
    @Query('source') source?: string,
    @Query('status') status?: string,
    @Query('capturedFrom') capturedFrom?: string,
    @Query('capturedTo') capturedTo?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.queryService.listRecords({
      page,
      pageSize,
      currency,
      source,
      status,
      capturedFrom,
      capturedTo,
      sortOrder
    });
  }

  @Get('settings')
  getSettings() {
    return this.settingsService.get();
  }

  @Patch('settings')
  @RequirePermissions('apple.exchange_rate.view', 'apple.exchange_rate.manage')
  updateSettings(
    @Body() dto: UpdateIdBusinessV2ExchangeRateSettingsDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.settingsService.update(dto, operator, request?.requestId);
  }

  @Post('collect')
  @RequirePermissions('apple.exchange_rate.view', 'apple.exchange_rate.collect')
  collect(@CurrentUser() operator?: AuthenticatedUser, @Req() request?: { requestId?: string }) {
    return this.worker.collectManual(operator, request?.requestId);
  }

  @Get('runs')
  listRuns(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('status') status?: string,
    @Query('triggerType') triggerType?: string,
    @Query('provider') provider?: string,
    @Query('collectedFrom') collectedFrom?: string,
    @Query('collectedTo') collectedTo?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.queryService.listRuns({
      page,
      pageSize,
      keyword,
      status,
      triggerType,
      provider,
      collectedFrom,
      collectedTo,
      sortOrder
    });
  }

  @Get('runs/:id')
  getRun(@Param('id') id: string) {
    return this.queryService.getRun(id);
  }

  @Get('manual-entries')
  listManualEntries(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('recordedFrom') recordedFrom?: string,
    @Query('recordedTo') recordedTo?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.exchangeRatesService.list({
      page,
      pageSize,
      keyword,
      recordedFrom,
      recordedTo,
      sortBy,
      sortOrder
    });
  }

  @Post('manual-entries')
  @RequirePermissions('apple.exchange_rate.view', 'apple.exchange_rate.create')
  create(
    @Body() dto: CreateIdBusinessV2ExchangeRateEntryDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.exchangeRatesService.create(dto, operator, request?.requestId);
  }

  @Get('manual-entries/:id')
  getManualEntry(@Param('id') id: string) {
    return this.exchangeRatesService.get(id);
  }

  @Get('manual-rates')
  listManualRates(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('currency') currency?: string,
    @Query('recordedFrom') recordedFrom?: string,
    @Query('recordedTo') recordedTo?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.exchangeRatesService.listManualFxRates({
      page,
      pageSize,
      keyword,
      currency,
      recordedFrom,
      recordedTo,
      sortOrder
    });
  }

  @Post('manual-rates')
  @RequirePermissions('apple.exchange_rate.view', 'apple.exchange_rate.create')
  createManualRate(
    @Body() dto: CreateIdBusinessV2ManualFxRateDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.exchangeRatesService.createManualFxRate(dto, operator, request?.requestId);
  }

  @Get('manual-rates/:id')
  getManualRate(@Param('id') id: string) {
    return this.exchangeRatesService.getManualFxRate(id);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.exchangeRatesService.get(id);
  }
}
