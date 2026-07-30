import { computed, reactive, ref, type ComputedRef } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { isV2UnsignedDecimal } from '@/v2/utils/decimal';
import { idBusinessV2FinanceApi } from './api';
import type { V2FinanceAccount, V2FinanceCurrency, V2FinanceSupplierWallet } from './contracts';

export type WalletMutationMode = 'deposit' | 'refund' | 'adjust';

export function useFinanceLedgerWallets(input: {
  accounts: ComputedRef<V2FinanceAccount[]>;
  refresh: () => Promise<unknown>;
}) {
  const walletDrawerVisible = ref(false);
  const walletSubmitting = ref(false);
  const walletForm = reactive({
    supplierOptionId: '',
    currency: 'CNY' as V2FinanceCurrency,
    openingBalance: '0',
    fxRateToCny: '',
    manualRateReason: '',
    reason: ''
  });
  const walletDirty = computed(() =>
    Boolean(
      walletForm.supplierOptionId ||
      walletForm.openingBalance !== '0' ||
      walletForm.fxRateToCny ||
      walletForm.manualRateReason ||
      walletForm.reason
    )
  );

  const walletMutationDrawerVisible = ref(false);
  const walletMutationSubmitting = ref(false);
  const walletMutationMode = ref<WalletMutationMode>('deposit');
  const selectedWallet = ref<V2FinanceSupplierWallet | null>(null);
  const walletMutationForm = reactive({
    financeAccountId: '',
    amount: '',
    creditedAmount: '',
    networkFeeAmount: '',
    targetBalance: '',
    occurredAt: toLocalDateTime(new Date()),
    fxRateToCny: '',
    manualRateReason: '',
    reason: '',
    network: '',
    transactionHash: '',
    remark: ''
  });
  const matchingFinanceAccounts = computed(() =>
    input.accounts.value.filter(
      (item) =>
        item.status === 'active' &&
        (!selectedWallet.value || item.currency === selectedWallet.value.currency)
    )
  );
  const walletMutationDirty = computed(() =>
    Object.values(walletMutationForm).some((value) => Boolean(value))
  );

  function openWallet() {
    Object.assign(walletForm, {
      supplierOptionId: '',
      currency: 'CNY',
      openingBalance: '0',
      fxRateToCny: '',
      manualRateReason: '',
      reason: ''
    });
    walletDrawerVisible.value = true;
  }

  async function submitWallet() {
    if (!walletForm.supplierOptionId) return showWarning('请选择供应商');
    if (!validUnsigned(walletForm.openingBalance, true)) return showWarning('期初余额格式不正确');
    if (!walletForm.reason.trim()) return showWarning('请填写期初依据');
    if (
      walletForm.currency !== 'CNY' &&
      walletForm.fxRateToCny &&
      !walletForm.manualRateReason.trim()
    ) {
      return showWarning('填写人工汇率时必须说明原因');
    }
    walletSubmitting.value = true;
    try {
      await idBusinessV2FinanceApi.createSupplierWallet({
        supplierOptionId: walletForm.supplierOptionId,
        currency: walletForm.currency,
        openingBalance: walletForm.openingBalance,
        fxRateToCny: walletForm.fxRateToCny || undefined,
        manualRateReason: walletForm.manualRateReason.trim() || undefined,
        reason: walletForm.reason.trim(),
        idempotencyKey: globalThis.crypto.randomUUID()
      });
      walletDrawerVisible.value = false;
      ElMessage.success('供应商钱包已创建');
      await input.refresh();
    } catch (cause) {
      ElMessage.error(getApiErrorMessage(cause));
    } finally {
      walletSubmitting.value = false;
    }
  }

  function openWalletMutation(wallet: V2FinanceSupplierWallet, mode: WalletMutationMode) {
    selectedWallet.value = wallet;
    walletMutationMode.value = mode;
    Object.assign(walletMutationForm, {
      financeAccountId: '',
      amount: '',
      creditedAmount: '',
      networkFeeAmount: '',
      targetBalance: mode === 'adjust' ? wallet.currentBalance : '',
      occurredAt: toLocalDateTime(new Date()),
      fxRateToCny: '',
      manualRateReason: '',
      reason: '',
      network: '',
      transactionHash: '',
      remark: ''
    });
    walletMutationDrawerVisible.value = true;
  }

  async function submitWalletMutation() {
    const wallet = selectedWallet.value;
    if (!wallet) return;
    if (walletMutationMode.value !== 'adjust' && !walletMutationForm.financeAccountId) {
      return showWarning('请选择资金账户');
    }
    const amount =
      walletMutationMode.value === 'adjust'
        ? walletMutationForm.targetBalance
        : walletMutationForm.amount;
    if (!validUnsigned(amount, walletMutationMode.value === 'adjust')) {
      return showWarning(
        walletMutationMode.value === 'adjust' ? '目标余额格式不正确' : '金额必须大于 0'
      );
    }
    if (
      (walletMutationMode.value === 'refund' || walletMutationMode.value === 'adjust') &&
      !walletMutationForm.reason.trim()
    ) {
      return showWarning('请填写操作原因');
    }
    if (
      wallet.currency !== 'CNY' &&
      walletMutationForm.fxRateToCny &&
      !walletMutationForm.manualRateReason.trim()
    ) {
      return showWarning('填写人工汇率时必须说明原因');
    }
    walletMutationSubmitting.value = true;
    try {
      if (walletMutationMode.value === 'deposit') {
        await idBusinessV2FinanceApi.depositSupplierWallet(wallet.id, {
          financeAccountId: walletMutationForm.financeAccountId,
          paidAmount: walletMutationForm.amount,
          creditedAmount: walletMutationForm.creditedAmount || undefined,
          networkFeeAmount: walletMutationForm.networkFeeAmount || undefined,
          paidAt: toIsoDate(walletMutationForm.occurredAt),
          fxRateToCny: walletMutationForm.fxRateToCny || undefined,
          manualRateReason: walletMutationForm.manualRateReason.trim() || undefined,
          network: walletMutationForm.network.trim() || undefined,
          transactionHash: walletMutationForm.transactionHash.trim() || undefined,
          remark: walletMutationForm.remark.trim() || undefined,
          idempotencyKey: globalThis.crypto.randomUUID()
        });
      } else if (walletMutationMode.value === 'refund') {
        await idBusinessV2FinanceApi.refundSupplierWallet(wallet.id, {
          financeAccountId: walletMutationForm.financeAccountId,
          amount: walletMutationForm.amount,
          receivedAt: toIsoDate(walletMutationForm.occurredAt),
          fxRateToCny: walletMutationForm.fxRateToCny || undefined,
          manualRateReason: walletMutationForm.manualRateReason.trim() || undefined,
          reason: walletMutationForm.reason.trim(),
          idempotencyKey: globalThis.crypto.randomUUID()
        });
      } else {
        await idBusinessV2FinanceApi.adjustSupplierWallet(wallet.id, {
          targetBalance: walletMutationForm.targetBalance,
          fxRateToCny: walletMutationForm.fxRateToCny || undefined,
          manualRateReason: walletMutationForm.manualRateReason.trim() || undefined,
          reason: walletMutationForm.reason.trim(),
          idempotencyKey: globalThis.crypto.randomUUID()
        });
      }
      walletMutationDrawerVisible.value = false;
      ElMessage.success('供应商钱包账务已更新');
      await input.refresh();
    } catch (cause) {
      ElMessage.error(getApiErrorMessage(cause));
    } finally {
      walletMutationSubmitting.value = false;
    }
  }

  return {
    walletDrawerVisible,
    walletSubmitting,
    walletForm,
    walletDirty,
    walletMutationDrawerVisible,
    walletMutationSubmitting,
    walletMutationMode,
    selectedWallet,
    walletMutationForm,
    matchingFinanceAccounts,
    walletMutationDirty,
    openWallet,
    submitWallet,
    openWalletMutation,
    submitWalletMutation
  };
}

function validUnsigned(value: string, allowZero: boolean) {
  return isV2UnsignedDecimal(value, { allowZero, decimalPlaces: 4 });
}

function showWarning(message: string) {
  ElMessage.warning(message);
}

function toLocalDateTime(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function toIsoDate(value: string) {
  return new Date(value).toISOString();
}
