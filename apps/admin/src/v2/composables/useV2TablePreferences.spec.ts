import { beforeEach, describe, expect, it, vi } from 'vitest';

const tablePreferencesApi = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
  reset: vi.fn()
}));

vi.mock('@/v2/api/tablePreferences', () => ({
  idBusinessV2TablePreferencesApi: tablePreferencesApi
}));

import {
  clearV2TablePreferences,
  ensureV2TablePreferences,
  getV2TableHiddenColumnKeys,
  isV2TableColumnVisible,
  resetV2TablePreference,
  saveV2TablePreference
} from './useV2TablePreferences';

describe('useV2TablePreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearV2TablePreferences();
    tablePreferencesApi.list.mockResolvedValue({ items: [] });
  });

  it('hydrates database preferences once and applies hidden keys by stable table id', async () => {
    tablePreferencesApi.list.mockResolvedValue({
      items: [
        {
          tableId: 'orders.main',
          hiddenColumnKeys: ['客户', '利润率'],
          updatedAt: '2026-08-08T00:00:00.000Z'
        }
      ]
    });

    await Promise.all([ensureV2TablePreferences('user-1'), ensureV2TablePreferences('user-1')]);

    expect(tablePreferencesApi.list).toHaveBeenCalledTimes(1);
    expect(isV2TableColumnVisible('orders.main', '客户')).toBe(false);
    expect(isV2TableColumnVisible('orders.main', '业务')).toBe(true);
  });

  it('replaces the in-memory preference only after a successful database save', async () => {
    tablePreferencesApi.update.mockResolvedValue({
      tableId: 'customers.main',
      hiddenColumnKeys: ['手机号'],
      updatedAt: '2026-08-08T00:01:00.000Z'
    });

    await saveV2TablePreference('user-1', 'customers.main', ['手机号', '手机号']);

    expect(tablePreferencesApi.update).toHaveBeenCalledWith('customers.main', {
      hiddenColumnKeys: ['手机号']
    });
    expect(getV2TableHiddenColumnKeys('customers.main')).toEqual(['手机号']);
  });

  it('clears the saved table entry after reset and isolates a switched user', async () => {
    tablePreferencesApi.update.mockResolvedValue({
      tableId: 'accounts.main',
      hiddenColumnKeys: ['国家'],
      updatedAt: '2026-08-08T00:02:00.000Z'
    });
    tablePreferencesApi.reset.mockResolvedValue({
      tableId: 'accounts.main',
      hiddenColumnKeys: [],
      deleted: true
    });
    tablePreferencesApi.list.mockResolvedValue({ items: [] });

    await saveV2TablePreference('user-1', 'accounts.main', ['国家']);
    await resetV2TablePreference('user-1', 'accounts.main');
    expect(isV2TableColumnVisible('accounts.main', '国家')).toBe(true);

    await ensureV2TablePreferences('user-2');
    expect(getV2TableHiddenColumnKeys('accounts.main')).toEqual([]);
  });
});
