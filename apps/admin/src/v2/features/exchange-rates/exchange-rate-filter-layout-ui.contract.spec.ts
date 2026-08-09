import { describe, expect, it } from 'vitest';
import tabs from './components/V2ExchangeRateTabs.vue?raw';

describe('exchange-rate filter row UI contract', () => {
  it('shows the automatic record count as a summary instead of a fake search input', () => {
    expect(tabs).toContain('class="v2-exchange-toolbar__summary"');
    expect(tabs).toContain('page.recordResolved');
    expect(tabs).not.toContain('placeholder="自动快照记录"');
  });

  it('assigns the dedicated grid action to automatic and manual search buttons', () => {
    expect(tabs.match(/class="v2-exchange-toolbar__search"/g)).toHaveLength(2);
    expect(tabs.match(/title="搜索"/g)).toHaveLength(2);
  });
});
