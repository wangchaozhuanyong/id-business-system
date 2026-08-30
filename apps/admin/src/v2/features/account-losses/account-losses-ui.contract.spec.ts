import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import view from './V2AccountLossesView.vue?raw';

const styles = readFileSync(new URL('../../styles/account-losses.css', import.meta.url), 'utf8');

describe('account losses UI contract', () => {
  it('uses a titled command panel and readable text actions', () => {
    expect(view).toContain('title="报损档案筛选"');
    expect(view).toContain('查询记录');
    expect(view).toContain('刷新记录');
    expect(view).not.toContain('icon-only');
  });

  it('keeps the filter panel responsive on narrow screens', () => {
    expect(styles).toContain('@media (max-width: 560px)');
    expect(styles).toContain('grid-template-columns: 1fr');
  });
});
