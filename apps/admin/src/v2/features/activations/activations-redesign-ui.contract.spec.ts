import { describe, expect, it } from 'vitest';
import view from './V2ActivationsView.vue?raw';
import pageState from './useActivationsPage.ts?raw';
import list from './components/V2ActivationsList.vue?raw';
import overview from './components/V2ActivationsOverview.vue?raw';
import toolbar from './components/V2ActivationsToolbar.vue?raw';

describe('activations scheme 3 redesign contract', () => {
  it('composes the overview, filters, records list and existing detail drawer', () => {
    expect(view).toContain('<V2ActivationsOverview :page="page" />');
    expect(view).toContain('<V2ActivationsToolbar :page="page" />');
    expect(view).toContain('<V2ActivationsList :page="page" />');
    expect(view).toContain('title="开通记录详情"');
    expect(view).toContain('const page = reactive(useActivationsPage())');
  });

  it('preserves due-status filtering, refresh and dynamic status evaluation', () => {
    expect(overview).toContain(':items="page.activationStatusStripItems"');
    expect(overview).toContain('@select="page.selectDueStatus"');
    expect(overview).toContain('@click="page.loadActivations"');
    expect(toolbar).toContain('v-model="page.query.keyword"');
    expect(toolbar).toContain('v-model="page.query.dueStatus"');
    expect(toolbar).toContain('v-model="page.dueRange"');
    expect(pageState).toContain('getRevalidateAt: (result) => result.revalidateAt');
    expect(pageState).toContain('function resetFilters()');
  });

  it('keeps the table, detail action and stable pagination frame', () => {
    expect(list).toContain(':schema="v2TableSchemas.activations.main"');
    expect(list).toContain('@click="page.openDetail(row)"');
    expect(list).toContain(':current-page="page.displayedPage"');
    expect(list).toContain(':page-size="page.displayedPageSize"');
    expect(list).toContain(':disabled="page.queryPhase === \'transitioning\'"');
    expect(list).toContain('useV2StableListFrame');
    expect(list.match(/@current-change=/g)).toHaveLength(1);
    expect(pageState).toContain('detailRequest.cancel()');
  });

  it('renders order profit once in the detail drawer', () => {
    expect(view.match(/<dt>订单利润<\/dt>/g)).toHaveLength(1);
    expect(view.match(/formatNullableDecimal\(page.detail.order.profitAmount\)/g)).toHaveLength(1);
  });
});
