import { describe, expect, it } from 'vitest';
import {
  formatCny,
  historyAssetOpeningAccountLabel,
  historyAssetOpeningDirectionLabel,
  isMeaningfulHistoryStatement
} from './financeLedgerPresentation';

describe('financeLedgerPresentation history asset opening', () => {
  it('formats the production opening adjustments with explicit account and direction labels', () => {
    expect(historyAssetOpeningAccountLabel('gift_card_inventory')).toBe('礼品卡库存');
    expect(historyAssetOpeningAccountLabel('id_inventory')).toBe('未售 ID 库存');
    expect(historyAssetOpeningDirectionLabel('debit')).toBe('借方补记');
    expect(historyAssetOpeningDirectionLabel('credit')).toBe('贷方冲减');
    expect(formatCny('1145.6')).toBe('¥1,145.60');
  });

  it('rejects placeholder confirmation notes and accepts an actual reconciliation conclusion', () => {
    expect(isMeaningfulHistoryStatement('111111')).toBe(false);
    expect(isMeaningfulHistoryStatement('aaaaaa')).toBe(false);
    expect(isMeaningfulHistoryStatement('已核对资金、卡商余额和旧开支')).toBe(true);
  });
});
