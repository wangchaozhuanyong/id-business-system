import { describe, expect, it } from 'vitest';
import {
  formatCny,
  historyAssetOpeningAccountLabel,
  historyAssetOpeningDirectionLabel
} from './financeLedgerPresentation';

describe('financeLedgerPresentation history asset opening', () => {
  it('formats the production opening adjustments with explicit account and direction labels', () => {
    expect(historyAssetOpeningAccountLabel('gift_card_inventory')).toBe('礼品卡库存');
    expect(historyAssetOpeningAccountLabel('id_inventory')).toBe('未售 ID 库存');
    expect(historyAssetOpeningDirectionLabel('debit')).toBe('借方补记');
    expect(historyAssetOpeningDirectionLabel('credit')).toBe('贷方冲减');
    expect(formatCny('1145.6')).toBe('¥1,145.60');
  });
});
