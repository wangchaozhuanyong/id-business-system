import { describe, expect, it } from 'vitest';
import view from './V2AccountsView.vue?raw';
import manifest from './manifest.ts?raw';
import accountImport from './account-import.ts?raw';
import accountsApi from '@/v2/api/accounts.ts?raw';
import rowActions from './components/V2AccountRowActions.vue?raw';
import saleRecoveryDialog from './components/V2AccountSaleRecoveryDialog.vue?raw';
import dialogs from './components/V2AccountDialogs.vue?raw';
import lifecycleTabs from './components/V2AccountLifecycleTabs.vue?raw';
import createOptions from './useAccountCreateOptions.ts?raw';
import list from './components/V2AccountsList.vue?raw';
import overview from './components/V2AccountsOverview.vue?raw';
import toolbar from './components/V2AccountsToolbar.vue?raw';
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
    expect(view).toContain('<V2AccountsOverview v-if="!showingLossRecords"');
    expect(view).toContain('<V2AccountsToolbar');
    expect(view).toContain('<V2AccountsList v-if="!showingLossRecords"');
    expect(overview).toContain('class="v2-accounts-overview__actions"');
    expect(overview).toContain('page.handleToolbarCommand');
    expect(overview).toContain('v-if="page.canCreate"');
    expect(toolbar).toContain('class="v2-account-command-panel"');
    expect(toolbar).toContain('class="v2-account-filter-grid"');
    expect(toolbar).toContain('更多筛选');
    expect(toolbar).toContain('page.activeFilterCount');
    expect(toolbar).toContain('page.resetFilters');
    expect(toolbar).toContain('敏感资料默认脱敏');
    expect(list).toContain('class="v2-account-list-heading"');
    expect(list).toContain('useV2StableListFrame');
    expect(view).not.toContain('v2-records-toolbar--accounts');
  });

  it('uses lifecycle shortcuts and omits destructive ID deletion', () => {
    expect(toolbar).toContain('<V2AccountLifecycleTabs');
    expect(list).toContain('page.openDisabledReason');
    expect(view).toContain('<V2AccountLossesView v-if="showingLossRecords"');
    expect(view).toContain("activeLifecycle.value === 'reported'");
    expect(view).not.toContain("router.push('/v2/records/account-losses')");
    expect(lifecycleTabs).toContain('props.showReported');
    expect(accountLossesManifest).toContain('navigation: false');
    expect(runtimeRegistry).toContain("key: 'account-losses'");
    expect(runtimeRegistry).toContain(
      "route: '/v2/records/account-losses',\n    navigation: false"
    );
    expect(rowActions).toContain('props.canReportLoss && !props.lossReported');
    expect(rowActions).not.toContain("props.saleState !== 'sold'");
    expect(rowActions).toContain('command="recover-sale"');
    expect(rowActions).toContain("props.saleState === 'sold'");
    expect(list).toContain('@recover-sale="page.openSaleRecovery');
    expect(dialogs).toContain('<V2AccountSaleRecoveryDialog');
    expect(saleRecoveryDialog).toContain('require-asterisk-position="right"');
    expect(saleRecoveryDialog).toContain('恢复原因');
    expect(saleRecoveryDialog).toContain(':close-on-click-modal="!page.saleRecoverySubmitting"');
    expect(saleRecoveryDialog).toContain(':before-close="beforeClose"');
    expect(saleRecoveryDialog).toContain('恢复原因尚未提交，确认关闭吗？');
    expect(saleRecoveryDialog).toContain('page.loadSaleRecoveryPreview');
    expect(saleRecoveryDialog).toContain('重新检查');
    expect(accountsApi).toContain('/recover-sold-account');
    expect(accountsApi).toContain("'finance-ledger'");
    expect(rowActions).not.toContain('删除 ID');
    expect(list).not.toContain('page.openDelete');
  });

  it('shows configured ID suppliers while preventing selection of disabled items', () => {
    expect(createOptions).toContain('includeDisabled: true');
    expect(dialogs).toContain("option.status === 'disabled'");
    expect(dialogs).toContain('（已停用）');
    expect(dialogs).toContain(':disabled="option.status === \'disabled\'"');
  });
});
