import { describe, expect, it } from 'vitest';
import view from './V2AccountsView.vue?raw';
import manifest from './manifest.ts?raw';
import accountImport from './account-import.ts?raw';
import runtimeRegistry from '@/v2/features/runtimeRegistry.ts?raw';

describe('ID management page UI contract', () => {
  it('uses the ID management name in navigation and import materials', () => {
    expect(manifest).toContain("title: 'ID管理'");
    expect(manifest).toContain("sourceSheet: 'ID管理'");
    expect(runtimeRegistry).toContain("title: 'ID管理'");
    expect(accountImport).toContain('ID管理导入模板');
  });

  it('separates page commands, common filters, advanced filters and security context', () => {
    expect(view).toContain('<V2PageContext');
    expect(view).toContain('class="v2-account-command-panel"');
    expect(view).toContain('class="v2-account-command-panel__actions"');
    expect(view).toContain('class="v2-account-filter-grid"');
    expect(view).toContain('更多筛选');
    expect(view).toContain('page.activeFilterCount');
    expect(view).toContain('page.resetFilters');
    expect(view).toContain('敏感资料默认脱敏');
    expect(view).toContain('class="v2-account-list-heading"');
    expect(view).not.toContain('v2-records-toolbar--accounts');
  });
});
