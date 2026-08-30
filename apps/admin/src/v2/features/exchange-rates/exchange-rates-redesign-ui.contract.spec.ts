import { describe, expect, it } from 'vitest';
import view from './V2ExchangeRatesView.vue?raw';
import overview from './components/V2ExchangeRatesOverview.vue?raw';
import purchasePanel from './components/V2PurchaseQuotePanel.vue?raw';
import tabs from './components/V2ExchangeRateTabs.vue?raw';
import pageState from './useExchangeRatesPage.ts?raw';

describe('exchange-rate streamlined redesign UI contract', () => {
  it('keeps the real page flow while delegating overview, task tabs and drawers', () => {
    expect(view).toContain('<V2ExchangeRatesOverview :page="page" />');
    expect(view).toContain('<V2ExchangeRateTabs :page="page" />');
    expect(view).toContain('<V2ExchangeRateDrawers :page="page" />');
  });

  it('keeps only high-frequency automatic actions in the overview', () => {
    expect(overview).toContain('v-if="page.canCollect"');
    expect(overview).toContain('v-if="page.canManage"');
    expect(overview).toContain('@click="page.collectNow"');
    expect(overview).toContain('@click="page.openSettings"');
    expect(overview).not.toContain('@click="page.openManualCreate"');
    expect(overview).not.toContain('@click="page.loadAll"');
    expect(pageState).not.toContain('function loadAll()');
  });

  it('uses lazy task tabs and keeps filtering inside each stable list frame', () => {
    expect(tabs.match(/<el-tab-pane/g)).toHaveLength(3);
    expect(tabs.match(/ lazy>/g)).toHaveLength(3);
    expect(tabs).toContain('v2-exchange-filterbar--automatic');
    expect(tabs).toContain('v2-exchange-filterbar--manual');
    expect(tabs).not.toContain('v2-exchange-command-panel');
    expect(tabs).not.toContain('v2-exchange-command-panel__footer');
    expect(tabs.match(/useV2StableListFrame\(/g)).toHaveLength(2);
    expect(purchasePanel).toContain('useV2StableListFrame');
    expect(tabs).toContain(':current-page="page.recordDisplayedPage"');
    expect(tabs).toContain(':current-page="page.manualDisplayedPage"');
  });

  it('moves contextual actions to their task and collapses low-frequency purchase tools', () => {
    expect(tabs).toContain('@click="page.openManualCreate"');
    expect(purchasePanel).toContain('生成报价');
    expect(purchasePanel).toContain('更新汇率');
    expect(purchasePanel).toContain('更多操作');
    expect(purchasePanel).toContain('command="history"');
    expect(purchasePanel).toContain('command="bulk"');
    expect(purchasePanel).toContain('command="settings"');
    expect(purchasePanel).not.toContain('v2-purchase-status-grid');
    expect(purchasePanel).not.toContain('多币种市场汇率每日免费自动采集已接入');
  });

  it('keeps table controls and detail cancellation while removing icon-only row actions', () => {
    expect(tabs.match(/<V2TableColumnSettings/g)).toHaveLength(2);
    expect(purchasePanel).toContain('<V2TableColumnSettings');
    expect(tabs.match(/:show-column-settings="false"/g)).toHaveLength(2);
    expect(purchasePanel).toContain(':show-column-settings="false"');
    expect(tabs).not.toContain('icon-only');
    expect(pageState).toContain('runDetailRequest.cancel()');
  });
});
