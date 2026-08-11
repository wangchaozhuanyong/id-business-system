import { describe, expect, it } from 'vitest';
import view from './V2ExchangeRatesView.vue?raw';
import overview from './components/V2ExchangeRatesOverview.vue?raw';
import tabs from './components/V2ExchangeRateTabs.vue?raw';

describe('exchange-rate option 3 redesign UI contract', () => {
  it('keeps the real page flow while delegating the overview and record tabs', () => {
    expect(view).toContain('<V2ExchangeRatesOverview :page="page" />');
    expect(view).toContain('<V2ExchangeRateTabs :page="page" />');
    expect(view).toContain('<V2ExchangeRateDrawers :page="page" />');
  });

  it('keeps every permission-controlled action visible in the overview', () => {
    expect(overview).toContain('v-if="page.canCollect"');
    expect(overview).toContain('v-if="page.canManage"');
    expect(overview).toContain('v-if="page.canCreate"');
    expect(overview).toContain('@click="page.collectNow"');
    expect(overview).toContain('@click="page.openSettings"');
    expect(overview).toContain('@click="page.openManualCreate"');
    expect(overview).toContain('@click="page.loadAll"');
  });

  it('places column settings in both list headings and keeps stable list frames', () => {
    expect(tabs.match(/<V2TableColumnSettings/g)).toHaveLength(2);
    expect(tabs.match(/:show-column-settings="false"/g)).toHaveLength(2);
    expect(tabs.match(/useV2StableListFrame\(/g)).toHaveLength(2);
    expect(tabs).toContain('本页 {{ page.records.length }} 条');
    expect(tabs).toContain('本页 {{ page.manualEntries.length }} 条');
    expect(tabs).not.toContain('v2-records-mobile-list');
  });

  it('preserves both repaired filter grids and their dedicated search actions', () => {
    expect(tabs).toContain('class="v2-exchange-toolbar__summary"');
    expect(tabs).toContain('class="v2-exchange-toolbar v2-exchange-toolbar--manual"');
    expect(tabs.match(/class="v2-exchange-toolbar__search"/g)).toHaveLength(2);
    expect(tabs.match(/title="搜索"/g)).toHaveLength(2);
  });
});
