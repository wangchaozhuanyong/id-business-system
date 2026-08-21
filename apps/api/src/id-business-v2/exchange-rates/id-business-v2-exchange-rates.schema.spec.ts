import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('V2 exchange-rate contracts', () => {
  it('keeps formula checks, immutable protection and create permission in the migration', () => {
    const migration = read(
      'prisma/migrations/20260729000000_current_system_baseline/migration.sql'
    );
    const seed = read('prisma/seed.ts');

    expect(migration).toContain('id_business_v2_exchange_rate_entries_rates_check');
    expect(migration).toContain('combined_merchant_buy_average_rate_to_rmb');
    expect(migration).toContain('combined_merchant_sell_average_rate_to_rmb');
    expect(migration).toContain('mid_rate_to_rmb');
    expect(migration).toContain('id_business_v2_exchange_rate_entry_immutable');
    expect(seed).toContain('apple.exchange_rate.create');
  });

  it('defines the deferred run validator that the clean baseline triggers invoke', () => {
    const baseline = read('prisma/migrations/20260729000000_current_system_baseline/migration.sql');
    const validatorMigration = read(
      'prisma/migrations/20260802011000_exchange_rate_validation_function/migration.sql'
    );

    expect(baseline).toContain('PERFORM "validate_id_business_v2_exchange_rate_run"');
    expect(baseline).not.toContain(
      'CREATE OR REPLACE FUNCTION public.validate_id_business_v2_exchange_rate_run(target_run_id'
    );
    expect(validatorMigration).toContain(
      'CREATE OR REPLACE FUNCTION public.validate_id_business_v2_exchange_rate_run(target_run_id UUID)'
    );
    expect(validatorMigration).toContain('provider_count <> 4');
    expect(validatorMigration).toContain('valid_ad_count');
  });

  it('keeps manual history isolated while exposing real collector endpoints', () => {
    const controller = read(
      'src/id-business-v2/exchange-rates/id-business-v2-exchange-rates.controller.ts'
    );
    const moduleSource = read(
      'src/id-business-v2/exchange-rates/id-business-v2-exchange-rates.module.ts'
    );
    expect(controller).toContain("@Post('manual-entries')");
    expect(controller).toContain("@Get('manual-entries')");
    expect(controller).toContain("@Post('collect')");
    expect(controller).toContain("@Post('cron')");
    expect(controller).toContain('@Public()');
    expect(controller).toContain("@Get('runtime')");
    expect(controller).toContain("@Patch('settings')");
    expect(controller).toContain('latestReceiptFxRates: overview.latestReceiptFxRates');
    expect(moduleSource).toContain('IdBusinessV2BinanceOtcCollector');
    expect(moduleSource).toContain('IdBusinessV2OkxOtcCollector');
    expect(moduleSource).toContain('IdBusinessV2ExchangeRateWorker');
    expect(moduleSource).toContain('IdBusinessV2ExchangeRateCronService');
    expect(moduleSource).not.toContain('IdBusinessV2ExchangeRateRetentionService');
  });

  it('adds database scheduling, source auditing and permissions without deleting manual data', () => {
    const migration = read(
      'prisma/migrations/20260729000000_current_system_baseline/migration.sql'
    );
    const seed = read('prisma/seed.ts');

    expect(migration).toContain('id_business_v2_exchange_rate_settings');
    expect(migration).toContain('id_business_v2_exchange_rate_settings_interval_check');
    expect(migration).toMatch(/"target_amount_rmb" DECIMAL\(18,\s*2\)/);
    expect(migration).toContain('"exchange_rate_snapshot_id" UUID');
    expect(migration).toMatch(/"exchange_rate_prefilled_value" DECIMAL\(18,\s*8\)/);
    expect(migration).toContain('"exchange_rate_was_overridden"');
    expect(seed).toContain('apple.exchange_rate.collect');
    expect(seed).toContain('apple.exchange_rate.manage');
    expect(migration).not.toContain('DROP TABLE "id_business_v2_exchange_rate_entries"');
  });

  it('schedules a 30-minute Supabase Cron and applies configurable FX retention', () => {
    const migration = read(
      'prisma/migrations/20260729000000_current_system_baseline/migration.sql'
    );
    const fourCurrencyMigration = read(
      'prisma/migrations/20260807010000_four_currency_exchange_rates/migration.sql'
    );
    const persistenceRepository = read(
      'src/id-business-v2/exchange-rates/persistence/id-business-v2-exchange-rate.repository.ts'
    );
    const cleanupFunction =
      fourCurrencyMigration.match(
        /CREATE OR REPLACE FUNCTION public\.cleanup_id_business_v2_exchange_rate_history\(\)[\s\S]*?\$function\$;/
      )?.[0] ?? '';

    expect(migration).toContain("'*/30 * * * *'");
    expect(migration).toContain('cleanup_id_business_v2_exchange_rate_history');
    expect(migration).toContain('id_business_v2_exchange_rate_cron_secret');
    expect(fourCurrencyMigration).toContain("ADD VALUE IF NOT EXISTS 'USD'");
    expect(fourCurrencyMigration).toContain('"retention_days" INTEGER NOT NULL DEFAULT 30');
    expect(fourCurrencyMigration).toContain(
      '"id_business_v2_exchange_rate_settings_retention_days_check"'
    );
    expect(cleanupFunction).toContain('make_interval(days => configured_retention_days)');
    expect(cleanupFunction).toContain('"id_business_v2_finance_fx_rate_snapshots"');
    expect(cleanupFunction).toContain(
      "fx_snapshot.\"source\" IN ('combined_p2p', 'binance', 'okx', 'ecb_cross')"
    );
    expect(cleanupFunction).toContain('"received_fx_snapshot_id" = fx_snapshot."id"');
    expect(cleanupFunction).toContain("'deletedFxRateSnapshots'");
    expect(cleanupFunction).not.toContain('id_business_v2_exchange_rate_entries');
    expect(persistenceRepository).toContain('UTC_TIMESTAMP(6)');
    expect(persistenceRepository).toContain('FOR UPDATE');
  });

  it('keeps purchase quotes independent, decimal based and immutable', () => {
    const migration = read(
      'prisma/migrations/20260820090000_purchase_quote_calculation/migration.sql'
    );
    const controller = read(
      'src/id-business-v2/exchange-rates/id-business-v2-exchange-rates.controller.ts'
    );

    expect(migration).toContain('id_business_v2_purchase_currencies');
    expect(migration).toContain('id_business_v2_purchase_rate_snapshots');
    expect(migration).toContain('purchase_rate_snapshot_immutable');
    expect(migration).toContain('DECIMAL(12, 8)');
    expect(migration).toContain("('USD', '美元', '美元', 0.70000000");
    expect(migration).toContain("('EUR', '欧元', '欧元', 0.60000000");
    expect(controller).toContain("@Get('purchase-quotes')");
    expect(controller).toContain("@Patch('purchase-quotes/:code')");
    expect(controller).toContain("'apple.exchange_rate.manage'");
  });

  it('adds hourly automatic purchase rates with a database lock and review boundary', () => {
    const migration = read(
      'prisma/migrations/20260820100000_purchase_rate_automation/migration.sql'
    );
    const controller = read(
      'src/id-business-v2/exchange-rates/id-business-v2-exchange-rates.controller.ts'
    );

    expect(migration).toContain('id_business_v2_purchase_rate_fetch_runs');
    expect(migration).toContain('id_business_v2_purchase_rate_fetch_runs_one_running_idx');
    expect(migration).toContain('WHERE "status" = \'running\'');
    expect(migration).toContain("'5 * * * *'");
    expect(migration).toContain("'pending_review'");
    expect(migration).toContain('abnormal_change_rate');
    expect(migration).toContain('"maximum_change_rate" DECIMAL(26, 8)');
    expect(migration).toContain('ADD COLUMN "change_rate" DECIMAL(26, 8)');
    expect(migration).toContain('WHEN EXTRACT(MINUTE FROM CURRENT_TIMESTAMP) < 5');
    expect(controller).toContain("@Post('purchase-quotes/refresh')");
    expect(controller).toContain("@Post('purchase-quotes/runs/:id/confirm')");
    expect(controller).toContain("@Patch('purchase-quotes/bulk')");
    expect(controller).toContain("@Get('purchase-quotes/text')");
  });
});
