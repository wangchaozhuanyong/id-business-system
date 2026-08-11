import { describe, expect, it } from 'vitest';
import view from './V2RenewalsView.vue?raw';
import pageState from './useRenewalsPage.ts?raw';
import list from './components/V2RenewalsList.vue?raw';
import overview from './components/V2RenewalsOverview.vue?raw';
import toolbar from './components/V2RenewalsToolbar.vue?raw';

describe('renewals scheme 3 redesign contract', () => {
  it('composes the overview, filters and list around the existing renewal dialogs', () => {
    expect(view).toContain('<V2RenewalsOverview :page="page" />');
    expect(view).toContain('<V2RenewalsToolbar :page="page" />');
    expect(view).toContain('<V2RenewalsList :page="page" />');
    expect(view).toContain('<V2RenewalWarningSettingsDialog');
    expect(view).toContain('<V2RenewalOrderDrawer');
    expect(view).toContain('const page = reactive(useRenewalsPage())');
  });

  it('preserves warning settings, renewal permissions and time-window guards', () => {
    expect(overview).toContain('v-if="page.canManageWarning"');
    expect(overview).toContain('@click="page.openWarningSettings"');
    expect(overview).toContain('@select="page.selectWarningScope"');
    expect(list).toContain('v-if="page.canRenew"');
    expect(list).toContain(':disabled="!row.withinActionWindow"');
    expect(list).toContain('@click="page.openRenewalDrawer(row)"');
    expect(pageState).toContain("hasUserPermission(authStore.user, 'apple.renewal_task.update')");
    expect(pageState).toContain("hasUserPermission(authStore.user, 'apple.order.create')");
  });

  it('keeps every existing filter and the stable pagination frame', () => {
    for (const binding of [
      'page.query.keyword',
      'page.query.dueStatus',
      'page.dueRange',
      'page.query.customerId',
      'page.query.serviceOptionId',
      'page.query.accountId'
    ]) {
      expect(toolbar).toContain(binding);
    }
    expect(list).toContain(':schema="v2TableSchemas.renewals.main"');
    expect(list).toContain(':current-page="page.displayedPage"');
    expect(list).toContain(':page-size="page.displayedPageSize"');
    expect(list).toContain(':disabled="page.queryPhase === \'transitioning\'"');
    expect(list).toContain('useV2StableListFrame');
  });

  it('keeps one renewal drawer visibility binding and all pricing previews', () => {
    expect(view.match(/v-model="page.drawerVisible"/g)).toHaveLength(1);
    for (const preview of [
      'page.platformFeePreview',
      'page.estimatedBalanceCostPreview',
      'page.estimatedProfitPreview',
      'page.estimatedProfitRatePreview',
      'page.suggestedReceived',
      'page.balanceAfterPreview'
    ]) {
      expect(view).toContain(preview);
    }
  });
});
