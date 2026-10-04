import type { V2FinanceCurrency } from '@apple-business/shared';
import { computed } from 'vue';
import type { FormRules } from 'element-plus';
import type { V2Order, V2OrderReceiptFinanceAccount } from './contracts';
import { isPositiveOrderAmount } from './order-pricing';

interface OrderReceiptAccountForm {
  receivedFinanceAccountId: string;
  receivedOriginalAmount?: string;
  receivedAmount?: string;
  receivedCurrency?: V2FinanceCurrency;
}

export function createOrderReceiptFinanceAccountRules(getError: () => string): FormRules {
  return {
    receivedFinanceAccountId: [
      {
        validator: (_rule, _value, callback) => {
          const error = getError();
          callback(error ? new Error(error) : undefined);
        },
        trigger: 'change'
      }
    ]
  };
}

export function useOrderReceiptFinanceAccount(
  form: OrderReceiptAccountForm,
  getAccounts: () => V2OrderReceiptFinanceAccount[],
  getPlatformFee: () => string,
  getOrder?: () => V2Order | null
) {
  const currency = () => form.receivedCurrency ?? getOrder?.()?.receivedCurrency ?? 'CNY';
  const receiptFinanceAccountRequired = computed(() =>
    requiresOrderReceiptFinanceAccount(
      form.receivedOriginalAmount ?? form.receivedAmount ?? '',
      getPlatformFee()
    )
  );
  const receiptFinanceAccountChoices = computed(() =>
    getOrderReceiptFinanceAccountChoices(
      getAccounts(),
      currency(),
      form.receivedFinanceAccountId,
      getOrder?.()?.receivedFinanceAccount
    )
  );
  const receiptFinanceAccountError = computed(() =>
    getOrder && !getOrder()?.operations.canEditReceiptAccount
      ? ''
      : getOrderReceiptFinanceAccountError(
          form.receivedFinanceAccountId,
          currency(),
          getAccounts(),
          receiptFinanceAccountRequired.value
        )
  );
  return {
    receiptFinanceAccountRequired,
    receiptFinanceAccountChoices,
    receiptFinanceAccountError
  };
}

export function requiresOrderReceiptFinanceAccount(receivedAmount: string, platformFee: string) {
  return isPositiveOrderAmount(receivedAmount) || isPositiveOrderAmount(platformFee);
}

export function getOrderReceiptFinanceAccountError(
  selectedId: string,
  currency: V2FinanceCurrency,
  accounts: V2OrderReceiptFinanceAccount[],
  required: boolean
) {
  if (!selectedId) return required ? `请选择 ${currency} 币种的真实收款账户` : '';
  const selected = accounts.find((account) => account.id === selectedId);
  if (!selected || !selected.isActive) return '原收款账户已停用或失效，请重新选择';
  if (selected.currency !== currency) return `收款账户币种必须为 ${currency}，请重新选择`;
  return '';
}

export function getOrderReceiptFinanceAccountChoices(
  accounts: V2OrderReceiptFinanceAccount[],
  currency: V2FinanceCurrency,
  selectedId: string,
  originalAccount?: V2OrderReceiptFinanceAccount | null
) {
  const choices = accounts
    .filter((account) => account.isActive && account.currency === currency)
    .map((account) => ({
      value: account.id,
      label: `${account.name} · ${account.currency}`,
      disabled: false
    }));
  if (!selectedId || choices.some((choice) => choice.value === selectedId)) return choices;
  const selected =
    accounts.find((account) => account.id === selectedId) ??
    (originalAccount?.id === selectedId ? originalAccount : null);
  return [
    {
      value: selectedId,
      label: selected
        ? `${selected.name} · ${selected.currency}（${selected.isActive && selected.currency !== currency ? '币种不匹配' : '已停用或失效'}）`
        : '原收款账户已失效',
      disabled: true
    },
    ...choices
  ];
}

export function preserveSelectedOrderReceiptFinanceAccount(
  accounts: V2OrderReceiptFinanceAccount[],
  selectedAccount: V2OrderReceiptFinanceAccount | null | undefined
) {
  if (!selectedAccount || accounts.some((account) => account.id === selectedAccount.id)) {
    return accounts;
  }
  return [{ ...selectedAccount, isActive: false }, ...accounts];
}
