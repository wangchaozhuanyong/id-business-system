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
    expect(moduleSource).toContain('IdBusinessV2BinanceOtcCollector');
    expect(moduleSource).toContain('IdBusinessV2OkxOtcCollector');
    expect(moduleSource).toContain('IdBusinessV2ExchangeRateWorker');
    expect(moduleSource).toContain('IdBusinessV2ExchangeRateCronService');
    expect(moduleSource).toContain('IdBusinessV2ExchangeRateRetentionService');
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

  it('schedules a 30-minute Supabase Cron and limits network history to one month', () => {
    const migration = read(
      'prisma/migrations/20260729000000_current_system_baseline/migration.sql'
    );
    const settingsService = read(
      'src/id-business-v2/exchange-rates/id-business-v2-exchange-rate-settings.service.ts'
    );
    const cleanupFunction =
      migration.match(
        /CREATE OR REPLACE FUNCTION public\.cleanup_id_business_v2_exchange_rate_history\(\)[\s\S]*?\$function\$;/
      )?.[0] ?? '';

    expect(migration).toContain("'*/30 * * * *'");
    expect(migration).toContain('cleanup_id_business_v2_exchange_rate_history');
    expect(migration).toContain("INTERVAL '1 month'");
    expect(migration).toContain('id_business_v2_exchange_rate_cron_secret');
    expect(cleanupFunction).toContain('"exchange_rate_snapshot_id" = snapshot."id"');
    expect(cleanupFunction).not.toContain('id_business_v2_exchange_rate_entries');
    expect(settingsService).toContain('EXTRACT(EPOCH FROM clock_timestamp())');
    expect(settingsService).toContain('FLOOR');
  });
});
