import type { V2FinanceCurrency } from '@apple-business/shared';
import { formatV2Decimal, isV2UnsignedDecimal, multiplyDecimalStrings } from '@/v2/utils/decimal';
import type { V2GiftCardPurchaseSources, V2TopupServiceSummary } from './contracts';

interface GiftCardPurchaseForm {
  purchaseOriginalAmount: string;
  purchaseCurrency: V2FinanceCurrency;
  purchaseFxRateToCny: string;
  supplierOptionId: string;
}

export function toLocalDateTimeInput(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

export function calculateCreditCostPreview(form: GiftCardPurchaseForm) {
  if (
    !isV2UnsignedDecimal(form.purchaseOriginalAmount, { allowZero: false }) ||
    (form.purchaseCurrency !== 'CNY' &&
      !isV2UnsignedDecimal(form.purchaseFxRateToCny, {
        allowZero: false,
        decimalPlaces: 8
      }))
  ) {
    return '';
  }
  return multiplyDecimalStrings(
    form.purchaseOriginalAmount,
    form.purchaseCurrency === 'CNY' ? '1' : form.purchaseFxRateToCny
  );
}

export function buildPurchaseSourceOptions(
  sources: V2GiftCardPurchaseSources,
  form: GiftCardPurchaseForm
) {
  return [
    ...sources.financeAccounts
      .filter((account) => account.currency === form.purchaseCurrency)
      .map((account) => ({
        value: `account:${account.id}`,
        label: `${account.name} · ${account.currency} · 余额 ${account.currentBalance}`,
        currentBalance: account.currentBalance,
        kind: 'account' as const
      })),
    ...sources.supplierWallets
      .filter(
        (wallet) =>
          wallet.currency === form.purchaseCurrency &&
          wallet.supplierOptionId === form.supplierOptionId
      )
      .map((wallet) => ({
        value: `wallet:${wallet.id}`,
        label: `${wallet.supplierName}预存 · ${wallet.currency} · 余额 ${wallet.currentBalance}`,
        currentBalance: wallet.currentBalance,
        kind: 'wallet' as const
      }))
  ];
}

export function effectiveRateUnavailableMessage(reason: string | null) {
  if (reason === 'latest_attempt_failed')
    return '最新一次 USDT 汇率采集失败，当前没有可展示的参考值。';
  if (reason === 'stale') return '最近一次 USDT 汇率已经过期，当前没有可展示的参考值。';
  if (reason === 'emergency_disabled') return 'USDT 汇率网络采集已关闭。';
  if (reason === 'collection_in_progress') return 'USDT 汇率正在采集中，请稍后查看。';
  return '暂无可展示的 USDT 参考汇率。';
}

export function maskGiftCardCode(value: string) {
  if (value.length < 8) return value;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

export function formatDecimal(value: string) {
  return formatV2Decimal(value);
}

export function isValidBalanceInput(value: string) {
  return !value || isV2UnsignedDecimal(value);
}

export function formatDate(value: string) {
  return formatDateTime(value, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function formatTime(value: string) {
  return formatDateTime(value, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

export function servicePath(service: V2TopupServiceSummary) {
  return service.parent ? `${service.parent.name} / ${service.name}` : service.name;
}

export function formatElapsed(value: string | null) {
  if (!value) return '-';
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours < 48) return `${Math.max(1, hours)} 小时前`;
  return `${Math.max(2, Math.floor(hours / 24))} 天前`;
}

function formatDateTime(value: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('zh-CN', { ...options, hour12: false }).format(new Date(value));
}
