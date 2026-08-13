import { describe, expect, it } from 'vitest';
import confirmDialog from './V2ConfirmDialog.vue?raw';
import detailSummary from './V2DetailSummary.vue?raw';
import formDrawer from './V2FormDrawer.vue?raw';
import panelSection from './V2PanelSection.vue?raw';
import sectionHeading from './V2SectionHeading.vue?raw';
import formSnapshot from '../composables/useV2FormSnapshot.ts?raw';
import accountDialogs from '../features/accounts/components/V2AccountDialogs.vue?raw';
import activationView from '../features/activations/V2ActivationsView.vue?raw';
import auditDrawer from '../features/audit-logs/components/V2AuditLogDetailDrawer.vue?raw';
import customerView from '../features/customers/V2CustomersView.vue?raw';
import governanceDrawers from '../features/data-governance/components/V2DataGovernanceDrawers.vue?raw';
import exchangeDrawers from '../features/exchange-rates/components/V2ExchangeRateDrawers.vue?raw';
import financeDrawers from '../features/finance-ledger/components/V2FinanceLedgerDrawers.vue?raw';
import optionDrawer from '../features/options/components/V2OptionFormDrawer.vue?raw';
import orderDialogs from '../features/orders/components/V2OrderDialogs.vue?raw';

describe('secondary page visual system contract', () => {
  it('provides one responsive summary structure for identity, metrics and facts', () => {
    expect(detailSummary).toContain('class="v2-detail-summary"');
    expect(detailSummary).toContain('class="v2-detail-summary__identity"');
    expect(detailSummary).toContain('class="v2-detail-summary__metrics"');
    expect(detailSummary).toContain('class="v2-detail-summary__facts"');
    expect(detailSummary).toContain('@media (max-width: 680px)');
    expect(detailSummary).toContain('overflow-wrap: anywhere');
  });

  it('uses numbered, labelled sections without changing the left-label form standard', () => {
    expect(panelSection).toContain(':aria-labelledby="headingId"');
    expect(panelSection).toContain(':title-id="headingId"');
    expect(sectionHeading).toContain(':id="titleId || undefined"');
    expect(formDrawer).toContain('class="v2-form-drawer__heading"');
    expect(formDrawer).toContain('v-if="eyebrow"');
    expect(formDrawer).toContain('v-if="description"');
  });

  it('protects unsaved forms and supports read-only confirmation dialogs', () => {
    expect(formSnapshot).toContain('JSON.stringify(source())');
    expect(formSnapshot).toContain('currentSnapshot.value !== initialSnapshot.value');
    expect(formDrawer).toContain(':before-close="handleBeforeClose"');
    expect(confirmDialog).toContain('v-if="confirmVisible"');
    expect(confirmDialog).toContain('{{ cancelText }}');
    expect(confirmDialog).toContain(':before-close="handleBeforeClose"');
  });

  it('applies the shared hierarchy across complex business modules', () => {
    for (const source of [activationView, auditDrawer, governanceDrawers, orderDialogs]) {
      expect(source).toContain('V2DetailSummary');
      expect(source).toContain('V2PanelSection');
    }
    for (const source of [
      accountDialogs,
      customerView,
      exchangeDrawers,
      financeDrawers,
      optionDrawer
    ]) {
      expect(source).toContain('V2PanelSection');
      expect(source).toContain(':dirty=');
    }
  });
});
