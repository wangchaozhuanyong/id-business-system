import { describe, expect, it } from 'vitest';
import tabs from './components/V2ExchangeRateTabs.vue?raw';

describe('exchange-rate filter row UI contract', () => {
  it('keeps the automatic record count in the list heading instead of a fake input', () => {
    expect(tabs).toContain('v2-exchange-filterbar--automatic');
    expect(tabs).toContain('page.recordResolved');
    expect(tabs).not.toContain('placeholder="自动快照记录"');
    expect(tabs).not.toContain('v2-exchange-toolbar__summary');
  });

  it('auto-applies select filters and keeps one explicit text query action', () => {
    expect(tabs.match(/@change="page.searchRecords"/g)).toHaveLength(4);
    expect(tabs).toContain(
      '<AppButton variant="ghost" @click="page.searchManual">查询</AppButton>'
    );
    expect(tabs).not.toContain('v2-exchange-toolbar__search');
    expect(tabs).not.toContain('icon-only');
  });
});
