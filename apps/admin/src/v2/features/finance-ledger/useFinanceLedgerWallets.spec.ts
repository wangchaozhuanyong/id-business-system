import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import { useFinanceLedgerWallets } from './useFinanceLedgerWallets';
import type { V2FinanceSupplierWallet } from './contracts';

const mutations = vi.hoisted(() => ({ deposit: vi.fn(), refund: vi.fn(), adjust: vi.fn() }));
vi.mock('./api', () => ({
  idBusinessV2FinanceApi: {
    depositSupplierWallet: mutations.deposit,
    refundSupplierWallet: mutations.refund,
    adjustSupplierWallet: mutations.adjust
  }
}));
vi.mock('@/v2/services/elementPlusMessage', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn() }
}));
vi.mock('@/v2/runtime/businessClock', () => ({
  ensureV2BusinessNowInput: async () => '2026-10-04T12:00:00',
  getV2BusinessNowInput: () => '2026-10-04T12:00:00'
}));

const wallet = {
  id: 'wallet',
  supplierName: '供应商',
  currency: 'CNY',
  currentBalance: '100',
  currentBalanceCny: '100',
  status: 'active'
} as V2FinanceSupplierWallet;

describe('supplier wallet submission idempotency', () => {
  beforeEach(() => {
    clearV2SessionDrafts();
    Object.values(mutations).forEach((mock) => mock.mockReset());
  });

  it.each(['deposit', 'refund', 'adjust'] as const)(
    'keeps the %s request key after a failed response and closing/reopening the draft',
    async (mode) => {
      const page = useFinanceLedgerWallets({ accounts: computed(() => []), refresh: vi.fn() });
      await page.openWalletMutation(wallet, mode);
      Object.assign(page.walletMutationForm, {
        financeAccountId: 'cash',
        amount: '10',
        targetBalance: '90',
        reason: '核对调整'
      });
      const request = mutations[mode];
      request.mockRejectedValueOnce(new Error('synthetic-response-lost')).mockResolvedValueOnce({});
      await page.submitWalletMutation();
      const firstKey = request.mock.calls[0][1].idempotencyKey;
      expect(firstKey).toBeTruthy();
      page.walletMutationDrawerVisible.value = false;
      await page.openWalletMutation(wallet, mode);
      await page.submitWalletMutation();
      expect(request.mock.calls[1][1].idempotencyKey).toBe(firstKey);
      expect(page.walletMutationDrawerVisible.value).toBe(false);
      await page.openWalletMutation(wallet, mode);
      expect(page.walletMutationForm.idempotencyKey).not.toBe(firstKey);
    }
  );
});
