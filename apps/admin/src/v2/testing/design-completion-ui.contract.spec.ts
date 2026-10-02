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
import themeComponentsFixture from './V2ThemeComponentsFixture.vue?raw';

function readStyle(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

const businessMonitoringCss = readStyle('../styles/business-monitoring.css');
const recordsCss = readStyle('../styles/records.css');
const baseCss = readStyle('../styles/base.css');

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
    expect(baseCss).toContain('html[data-v2-theme] .el-pagination button');
    expect(baseCss).toContain('min-width: 36px');
    expect(baseCss).toContain('min-height: 36px');
    expect(businessMonitoringCss).toMatch(
      /\.v2-business-monitoring-severity button\s*\{[^}]*min-height: 36px/s
    );
  });

  it('prevents sensitive contact reveal actions from shrinking inside table cells', () => {
    expect(recordsCss).toMatch(/\.v2-sensitive-cell > \.app-button--icon\s*\{[^}]*flex: 0 0 36px/s);
  });

  it('gives every semantic table status a distinct shared visual treatment', () => {
    expect(baseCss).toContain('.v2-table-column--status .el-tag');
    expect(baseCss).toContain('.el-tag.v2-status-tag');
    for (const statusType of ['primary', 'success', 'warning', 'danger', 'info']) {
      expect(baseCss).toContain(`.el-tag--${statusType}`);
      expect(themeComponentsFixture).toContain(`statusType: '${statusType}'`);
    }
  });
});
