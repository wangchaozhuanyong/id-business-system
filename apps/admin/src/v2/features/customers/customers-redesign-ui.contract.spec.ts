import { describe, expect, it } from 'vitest';
import view from './V2CustomersView.vue?raw';
import pageState from './useCustomersPage.ts?raw';
import list from './components/V2CustomersList.vue?raw';
import overview from './components/V2CustomersOverview.vue?raw';
import toolbar from './components/V2CustomersToolbar.vue?raw';

describe('customers scheme 3 redesign contract', () => {
  it('composes the overview, filters and records list without replacing business drawers', () => {
    expect(view).toContain('<V2CustomersOverview :page="page" />');
    expect(view).toContain('<V2CustomersToolbar :page="page" />');
    expect(view).toContain('<V2CustomersList :page="page" />');
    expect(view).toContain('<V2CustomerSensitiveAccessDialog :page="page" />');
    expect(view).toContain('require-asterisk-position="right"');
  });

  it('preserves the original permission gates and customer actions', () => {
    expect(overview).toContain('v-if="page.canCreate"');
    expect(overview).toContain('@click="page.loadCustomers"');
    expect(list).toContain(':can-reveal="page.canRevealContact && !page.isParameterTransition"');
    expect(list).toContain('@click="page.openEdit(row)"');
    expect(list).toContain('@click="page.toggleStatus(row)"');
    expect(list).toContain('@click="page.openDelete(row)"');
  });

  it('keeps filtering explicit and stabilizes the list across pagination states', () => {
    expect(toolbar).toContain('v-model="page.query.keyword"');
    expect(toolbar).toContain('v-model="page.query.sourceOptionId"');
    expect(toolbar).toContain('v-model="page.query.tagOptionId"');
    expect(toolbar).toContain('v-model="page.query.serviceOptionId"');
    expect(toolbar).toContain('v-model="page.query.recordStatus"');
    expect(pageState).toContain('function resetFilters()');
    expect(list).toContain('useV2StableListFrame');
    expect(list.match(/@current-change=/g)).toHaveLength(1);
  });

  it('requires a fresh dependency preview before customer deletion', () => {
    expect(view).toContain('deleteImpactRows');
    expect(view).toContain(':confirm-disabled-reason="deleteConfirmDisabledReason"');
    expect(pageState).toContain('getDeletePreview');
    expect(pageState).toContain('deletePreviewRequestId');
    expect(pageState).toContain("error.kind === 'conflict'");
  });
});
