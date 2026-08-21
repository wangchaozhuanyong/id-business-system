import { describe, expect, it } from 'vitest';
import tabs from './components/V2ExchangeRateTabs.vue?raw';
import panel from './components/V2PurchaseQuotePanel.vue?raw';
import drawer from './components/V2PurchaseQuoteDrawer.vue?raw';
import editorState from './usePurchaseQuoteEditor.ts?raw';
import automationDrawers from './components/V2PurchaseRateAutomationDrawers.vue?raw';
import automationState from './usePurchaseRateAutomation.ts?raw';

describe('purchase quote UI contract', () => {
  it('adds a real purchase quote tab with separate market and purchase prices', () => {
    expect(tabs).toContain('label="收购报价"');
    expect(tabs).toContain('<V2PurchaseQuotePanel :page="page" />');
    expect(panel).toContain('国际人民币汇率');
    expect(panel).toContain('今日收购价');
    expect(panel).toContain('美元与其他币种完全独立');
    expect(panel).toContain('最新汇率更新时间');
    expect(panel).toContain('已启用币种');
    expect(panel).toContain('下一次更新时间');
    expect(panel).toContain('汇率接口状态');
    expect(panel).toContain('Rates By Exchange Rate API');
    expect(panel).toContain('每天北京时间 09:05 执行');
    expect(panel).toContain("? '部分收购报价已超过有效时限'");
    expect(panel).toContain("? 'error'");
    expect(panel).toContain('V2TableActionColumn');
  });

  it('uses a left-label protected drawer and exposes exact calculation preview', () => {
    expect(drawer).toContain('label-position="left"');
    expect(drawer).toContain('require-asterisk-position="right"');
    expect(drawer).toContain(':dirty="dirty"');
    expect(drawer).toContain('page.purchasePreview.purchaseRateFormatted');
    expect(drawer).toContain('向下截断');
    expect(drawer).toContain('四舍五入');
    expect(drawer).toContain('向上取整');
    expect(drawer).toContain('手工覆盖汇率必须填写来源说明');
    expect(editorState).toContain('calculateV2PurchaseRate');
    expect(editorState).toContain('updatePurchaseQuote');
  });

  it('exposes automatic refresh, review, history, bulk ratio and copy workflows', () => {
    expect(panel).toContain('立即刷新');
    expect(panel).toContain('生成报价文本');
    expect(panel).toContain('批量设置比例');
    expect(automationDrawers).toContain('确认并发布候选报价');
    expect(automationDrawers).toContain('每天北京时间 09:05');
    expect(automationDrawers).toContain('微信排版');
    expect(automationDrawers).toContain('等宽排版');
    expect(automationDrawers).toContain('纯文本');
    expect(automationDrawers).toContain('label-position="left"');
    expect(automationDrawers).toContain(':dirty="settingsDirty"');
    expect(automationDrawers).toContain(':dirty="bulkDirty"');
    expect(automationState).toContain('useV2ModuleQuery');
    expect(automationState).toContain('bulkUpdatePurchaseQuotes');
    expect(automationState).toContain('请至少选择一个币种');
    expect(automationState).toContain('navigator.clipboard.writeText');
    expect(automationState).toContain("document.execCommand('copy')");
  });
});
