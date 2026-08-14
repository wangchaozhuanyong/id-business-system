import { describe, expect, it } from 'vitest';
import view from './V2RenewalsView.vue?raw';
import pageState from './useRenewalsPage.ts?raw';
import list from './components/V2RenewalsList.vue?raw';
import overview from './components/V2RenewalsOverview.vue?raw';
import toolbar from './components/V2RenewalsToolbar.vue?raw';
import drawer from './components/V2RenewalOrderDrawer.vue?raw';
import fixture from '../../testing/V2RenewalsDesignFixture.vue?raw';
import serviceSelection from './useRenewalServiceSelection.ts?raw';

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
    expect(overview).not.toContain('V2StatusStrip');
    expect(toolbar).toContain('class="v2-renewal-scope-control"');
    expect(toolbar).toContain('@click="page.selectWarningScope(item.key)"');
    expect(toolbar).toContain("props.page.selectWarningScope('warning')");
    expect(pageState).toContain('const warningOnly = ref(true)');
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
    expect(list).toContain(":default-sort=\"{ prop: 'openedAt', order: 'descending' }\"");
    expect(list).toContain('prop="openedAt"');
    expect(pageState).toContain("sortBy: 'openedAt'");
    expect(pageState).toContain("sortOrder: 'desc'");
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

  it('organizes the renewal drawer into a consistent secondary-page structure', () => {
    for (const section of [
      '续费对象',
      '续费业务',
      '收款与余额',
      '结算信息',
      '续费周期',
      '补充说明',
      '费用与利润'
    ]) {
      expect(drawer).toContain(section);
    }
    expect(drawer).toContain('class="v2-renewal-open__facts"');
    expect(drawer).toContain('class="v2-renewal-open__summary"');
    expect(drawer).toContain('require-asterisk-position="right"');
    expect(fixture).toContain('<V2RenewalOrderDrawer');
    expect(fixture).toContain("fixtureParams.get('drawer') === 'open'");
    expect(fixture).toContain('未提交任何业务数据');
  });

  it('defaults to the current service and supports category-first service selection', () => {
    expect(pageState).toContain("categoryOptionId: renewal.service.parent?.id ?? ''");
    expect(pageState).toContain('serviceOptionId: renewal.service.id');
    expect(pageState).toContain('useRenewalServiceSelection(options, selectedRenewal, form)');
    expect(serviceSelection).toContain('const availableCategories = computed');
    expect(serviceSelection).toContain('const categoryServices = computed');
    expect(serviceSelection).toContain('function handleRenewalCategoryChange()');
    expect(view).toContain('v-model:category-option-id="page.form.categoryOptionId"');
    expect(view).toContain(':categories="page.availableCategories"');
    expect(view).toContain(':services="page.categoryServices"');
    expect(drawer).toContain('label="业务分类"');
    expect(drawer).toContain('label="续费业务"');
    expect(drawer).toContain(':disabled="!categoryOptionId"');
    expect(drawer).toContain(':dirty="formDirty"');
    expect(drawer).toContain('currentFormSnapshot.value !== initialFormSnapshot.value');
    expect(fixture).toContain("categoryOptionId: 'category-ai'");
  });
});
