import { V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES } from '@apple-business/shared';
import { formatV2Decimal, isV2UnsignedDecimal, multiplyDecimalStrings } from '@/v2/utils/decimal';
import type {
  V2ExchangeRateCurrency,
  V2ExchangeRateRecord,
  V2ExchangeRateReceiptFxRate,
  V2ExchangeRateRun,
  V2TrackedExchangeRateCurrency
} from './contracts';

export const defaultIntervals = [5, 15, 30, 60, 180, 360, 720, 1440];
export const trackedCurrencies: V2TrackedExchangeRateCurrency[] = ['MYR', 'USD', 'USDT'];

const failureReasonByCode: Record<string, string> = {
  binance_otc_http_error: '平台接口返回异常',
  binance_otc_timeout: '请求超时',
  binance_otc_network_error: '网络连接失败',
  binance_otc_invalid_response: '返回数据格式异常',
  binance_otc_provider_error: '平台拒绝了采集请求',
  binance_otc_empty_side: '未返回有效报价',
  binance_otc_invalid_target: '成交额参数无效',
  okx_otc_http_error: '平台接口返回异常',
  okx_otc_timeout: '请求超时',
  okx_otc_network_error: '网络连接失败',
  okx_otc_invalid_response: '返回数据格式异常',
  okx_otc_provider_error: '平台拒绝了采集请求',
  okx_otc_empty_side: '未返回有效报价',
  okx_otc_invalid_target: '成交额参数无效',
  otc_average_provider_collection_failed: '至少一个平台采集失败',
  otc_average_invalid_collection: '采集结果无效',
  otc_average_insufficient_valid_quotes: '有效报价数量不足',
  exchange_rate_stale_run_recovered: '超时采集任务已自动终止',
  exchange_rate_unexpected_failure: '采集过程发生未知错误'
};

export function runStatusLabel(status: V2ExchangeRateRun['status']) {
  return { running: '采集中', success: '成功', failed: '失败' }[status];
}

export function runStatusType(status: V2ExchangeRateRun['status']) {
  return status === 'success' ? 'success' : status === 'failed' ? 'danger' : 'warning';
}

export function triggerLabel(trigger: V2ExchangeRateRun['triggerType']) {
  return { scheduled: '定时采集', manual: '立即采集', system: '系统采集' }[trigger];
}

export function currencyLabel(currency: V2ExchangeRateCurrency | null | undefined) {
  if (currency === 'CNY') return '人民币 CNY';
  if (currency === 'MYR') return '马币 MYR';
  if (currency === 'USD') return '美元 USD';
  if (currency === 'USDT') return 'USDT';
  return '-';
}

export function currencySymbol(currency: V2ExchangeRateCurrency | null | undefined) {
  if (currency === 'CNY') return '¥';
  if (currency === 'MYR') return 'RM ';
  if (currency === 'USD') return '$';
  if (currency === 'USDT') return '₮';
  return '';
}

export function providerLabel(provider: string | null | undefined) {
  if (provider === 'binance') return 'Binance';
  if (provider === 'okx') return 'OKX';
  if (provider === 'multiple') return 'Binance、OKX';
  if (provider === 'system') return '系统';
  return '-';
}

export function sideLabel(side: string | null | undefined) {
  if (side === 'merchant_buy') return '商家买入';
  if (side === 'merchant_sell') return '商家卖出';
  return '';
}

export function failureLabel(run: Pick<V2ExchangeRateRun, 'error'>) {
  if (!run.error) return '-';
  return `${providerLabel(run.error.provider)} ${sideLabel(run.error.side)} ${failureReason(
    run.error
  )}`.trim();
}

export function failureReason(error: NonNullable<V2ExchangeRateRun['error']>) {
  return failureReasonByCode[error.code] || error.message || '采集失败，请查看批次详情';
}

export function recordStatusLabel(status: V2ExchangeRateRecord['status']) {
  return status === 'available' ? '有效' : '已过期';
}

export function recordStatusType(status: V2ExchangeRateRecord['status']) {
  return status === 'available' ? 'success' : 'warning';
}

export function receiptFxStatusLabel(status: V2ExchangeRateReceiptFxRate['status']) {
  return {
    fixed: '固定',
    available: '有效',
    expired: '已过期',
    missing: '缺失'
  }[status];
}

export function receiptFxStatusType(status: V2ExchangeRateReceiptFxRate['status']) {
  return {
    fixed: 'success',
    available: 'success',
    expired: 'warning',
    missing: 'danger'
  }[status] as 'success' | 'warning' | 'danger';
}

export function receiptFxSourceLabel(source: string | null | undefined) {
  if (source === 'cny_fixed') return '人民币固定汇率';
  if (source === 'combined_p2p') return 'Binance + OKX P2P';
  if (source === 'ecb_cross') return 'ECB 交叉汇率';
  if (source === 'manual') return '人工汇率';
  return source || '暂无来源';
}

export function parseExchangeRateInput(value: string) {
  const normalized = value.trim();
  return isV2UnsignedDecimal(normalized, {
    allowZero: false,
    decimalPlaces: V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES
  })
    ? normalized
    : null;
}

export function formatRate(value: string | null | undefined) {
  return formatV2Decimal(value);
}

export function formatAmount(value: string | null | undefined) {
  return formatV2Decimal(value);
}

export function formatDate(value: string | null | undefined) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(value));
}

export function formatPercent(value: string | null | undefined) {
  if (!value) return '-';
  return `${formatV2Decimal(multiplyDecimalStrings(value, '100'))}%`;
}

export function intervalLabel(minutes: number | undefined) {
  if (!minutes) return '-';
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  return `${minutes / 60} 小时`;
}

export function operatorName(entry: { createdBy: { username: string } | null }) {
  return entry.createdBy?.username || '-';
}

export function receiptFxCapturedLabel(rate: V2ExchangeRateReceiptFxRate) {
  return rate.capturedAt ? `采集于 ${formatDate(rate.capturedAt)}` : '暂无记录';
}
