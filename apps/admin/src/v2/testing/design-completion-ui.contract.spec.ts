/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import accountsFixture from './V2AccountsDesignFixture.vue?raw';
import activationsFixture from './V2ActivationsDesignFixture.vue?raw';
import customersFixture from './V2CustomersDesignFixture.vue?raw';
import exchangeRatesFixture from './V2ExchangeRatesDesignFixture.vue?raw';
import optionsFixture from './V2OptionsDesignFixture.vue?raw';
import ordersFixture from './V2OrdersDesignFixture.vue?raw';
import renewalsFixture from './V2RenewalsDesignFixture.vue?raw';
import topupRecordsFixture from './V2TopupRecordsDesignFixture.vue?raw';
import topupsFixture from './V2TopupsDesignFixture.vue?raw';

function readStyle(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

const businessMonitoringCss = readStyle('../styles/business-monitoring.css');
const recordsCss = readStyle('../styles/records.css');
const v2Css = readStyle('../styles/v2.css');

const emptyStateFixtures = [
  accountsFixture,
  activationsFixture,
  customersFixture,
  exchangeRatesFixture,
  optionsFixture,
  ordersFixture,
  renewalsFixture,
  topupRecordsFixture,
  topupsFixture
];

describe('scheme 3 design completion contract', () => {
  it('provides explicit empty states for every remaining data fixture', () => {
    for (const fixture of emptyStateFixtures) {
      expect(fixture).toContain("get('state') === 'empty'");
      expect(fixture).not.toContain('http.');
    }
  });

  it('keeps shared pagination and compact controls at the minimum click target size', () => {
    expect(v2Css).toContain('.v2-shell .el-pagination button');
    expect(v2Css).toContain('min-width: 36px');
    expect(v2Css).toContain('min-height: 36px');
    expect(businessMonitoringCss).toMatch(
      /\.v2-business-monitoring-severity button\s*\{[^}]*min-height: 36px/s
    );
  });

  it('prevents sensitive contact reveal actions from shrinking inside table cells', () => {
    expect(recordsCss).toMatch(/\.v2-sensitive-cell > \.app-button--icon\s*\{[^}]*flex: 0 0 36px/s);
  });
});
