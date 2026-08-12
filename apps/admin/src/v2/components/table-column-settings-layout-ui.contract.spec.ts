import { describe, expect, it } from 'vitest';
import table from './V2Table.vue?raw';
import settings from './V2TableColumnSettings.vue?raw';
import accounts from '@/v2/features/accounts/components/V2AccountsList.vue?raw';
import activations from '@/v2/features/activations/components/V2ActivationsList.vue?raw';
import customers from '@/v2/features/customers/components/V2CustomersList.vue?raw';
import orders from '@/v2/features/orders/components/V2OrdersList.vue?raw';
import options from '@/v2/features/options/components/V2OptionsList.vue?raw';
import renewals from '@/v2/features/renewals/components/V2RenewalsList.vue?raw';
import topupRecords from '@/v2/features/topup-records/components/V2TopupRecordsTables.vue?raw';

describe('table column settings header layout contract', () => {
  it('supports moving the shared column settings trigger into a list heading', () => {
    expect(table).toContain('showColumnSettings');
    expect(table).toContain('props.showColumnSettings ? h(V2TableColumnSettings');
    expect(settings).toContain("'v2-table-preference-toolbar--inline': inline");
  });

  it('only exposes localized column labels to users', () => {
    expect(settings).toContain('{{ column.label }}');
    expect(settings).not.toMatch(/\{\{\s*column\.key\s*\}\}/);
    expect(settings).not.toContain("column.key.toLocaleLowerCase('zh-CN')");
  });

  it('keeps redesigned data-table settings beside the page-count summary', () => {
    for (const source of [
      accounts,
      activations,
      customers,
      orders,
      options,
      renewals,
      topupRecords
    ]) {
      const settingsIndex = source.indexOf('<V2TableColumnSettings');
      const pageCountIndex = source.indexOf('本页 {{');
      expect(settingsIndex).toBeGreaterThan(-1);
      expect(pageCountIndex).toBeGreaterThan(settingsIndex);
      expect(source).toContain(':show-column-settings="false"');
    }
  });
});
