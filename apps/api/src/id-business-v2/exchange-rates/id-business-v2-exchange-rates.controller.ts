import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, Public, RequirePermissions } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { CreateIdBusinessV2ExchangeRateEntryDto } from './dto/create-id-business-v2-exchange-rate-entry.dto';
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
    @Query('manualPage') manualPage?: string,
    @Query('manualPageSize') manualPageSize?: string,
    @Query('manualKeyword') manualKeyword?: string,
    @Query('manualRecordedFrom') manualRecordedFrom?: string,
    @Query('manualRecordedTo') manualRecordedTo?: string
  ) {
    const [overview, runtime, runs, manualEntries] = await Promise.all([
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
      this.exchangeRatesService.list({
        page: manualPage,
        pageSize: manualPageSize,
        keyword: manualKeyword,
        recordedFrom: manualRecordedFrom,
        recordedTo: manualRecordedTo,
        sortBy: 'recordedAt',
        sortOrder: 'desc'
      })
    ]);
    return {
      overview,
      runtime,
      runs,
      manualEntries,
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

  @Get('settings')
  getSettings() {
    return this.settingsService.get();
  }

  @Patch('settings')
  @RequirePermissions('apple.exchange_rate.view', 'apple.exchange_rate.manage')
  updateSettings(
    @Body() dto: UpdateIdBusinessV2ExchangeRateSettingsDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.settingsService.update(dto, operator);
  }

  @Post('collect')
  @RequirePermissions('apple.exchange_rate.view', 'apple.exchange_rate.collect')
  collect(@CurrentUser() operator?: AuthenticatedUser) {
    return this.worker.collectManual(operator);
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
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.exchangeRatesService.create(dto, operator);
  }

  @Get('manual-entries/:id')
  getManualEntry(@Param('id') id: string) {
    return this.exchangeRatesService.get(id);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.exchangeRatesService.get(id);
  }
}
