import { describe, expect, it } from 'vitest';
import view from './V2AccountsView.vue?raw';
import manifest from './manifest.ts?raw';
import accountImport from './account-import.ts?raw';
import rowActions from './components/V2AccountRowActions.vue?raw';
import dialogs from './components/V2AccountDialogs.vue?raw';
import lifecycleTabs from './components/V2AccountLifecycleTabs.vue?raw';
import createOptions from './useAccountCreateOptions.ts?raw';
import accountLossesManifest from '@/v2/features/account-losses/manifest.ts?raw';
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

  it('uses lifecycle shortcuts and omits destructive ID deletion', () => {
    expect(view).toContain('<V2AccountLifecycleTabs');
    expect(view).toContain('page.openDisabledReason');
    expect(view).toContain('<V2AccountLossesView v-if="showingLossRecords"');
    expect(view).toContain("activeLifecycle.value === 'reported'");
    expect(view).not.toContain("router.push('/v2/records/account-losses')");
    expect(lifecycleTabs).toContain('props.showReported');
    expect(accountLossesManifest).toContain('navigation: false');
    expect(runtimeRegistry).toContain("key: 'account-losses'");
    expect(runtimeRegistry).toContain(
      "route: '/v2/records/account-losses',\n    navigation: false"
    );
    expect(rowActions).toContain("props.saleState !== 'sold'");
    expect(rowActions).not.toContain('删除 ID');
    expect(view).not.toContain('page.openDelete');
  });

  it('shows configured ID suppliers while preventing selection of disabled items', () => {
    expect(createOptions).toContain('includeDisabled: true');
    expect(dialogs).toContain("option.status === 'disabled'");
    expect(dialogs).toContain('（已停用）');
    expect(dialogs).toContain(':disabled="option.status === \'disabled\'"');
  });
});
