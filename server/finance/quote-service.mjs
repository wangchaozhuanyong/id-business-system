import { isDeepStrictEqual } from 'node:util';

import {
  automaticProvider, createAutomaticOrderSnapshot, currencies
} from '../../modules/finance/accounting.mjs';

const endpoint = 'https://open.er-api.com/v6/latest/CNY';
const maximumAge = 36 * 60 * 60 * 1000;
const scale = 100_000_000n;

function toCny(raw) {
  if (typeof raw !== 'string' || !/^\d{1,12}(?:\.\d{1,16})?$/.test(raw))
    throw new Error('报价缺失或格式无效');
  const [whole, fraction = ''] = raw.split('.');
  const units = BigInt(whole + fraction);
  if (!units) throw new Error('报价必须大于零');
  const inverted = (scale * 10n ** BigInt(fraction.length) + units / 2n) / units;
  if (!inverted) throw new Error('报价超出精度范围');
  return `${inverted / scale}.${String(inverted % scale).padStart(8, '0')}`;
}

export async function readFinanceQuote(response, clock, codes = currencies, partial = false) {
  // Preserve the provider's original JSON digits for exact reciprocal rounding.
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error('供应商响应过长');
  const data = JSON.parse(text, (_key, value, context) =>
    typeof value === 'number' ? context.source : value
  );
  if (data?.result !== 'success' || data.base_code !== 'CNY' ||
      typeof data.rates !== 'object' || !data.rates ||
      !/^\d{10}$/.test(data.time_last_update_unix) || !/^\d{10}$/.test(data.time_next_update_unix))
    throw new Error('供应商报价格式无效');
  const at = Number(data.time_last_update_unix) * 1000;
  const next = Number(data.time_next_update_unix) * 1000;
  const eol = Number(data.time_eol_unix);
  if (!Number.isSafeInteger(eol) || eol < 0) throw new Error('供应商有效期格式无效');
  const fetchedAt = clock();
  const expiresAt = Math.min(next, at + maximumAge, eol ? eol * 1000 : Infinity);
  if (!(at <= fetchedAt && fetchedAt < expiresAt)) throw new Error('供应商报价尚未生效或已过期');
  if (!/^1(?:\.0+)?$/.test(data.rates.CNY))
    throw new Error('供应商报价基准无效');
  const rates = { CNY: '1' }, errors = {};
  for (const code of codes.filter(code => code !== 'CNY')) {
    try { rates[code] = toCny(data.rates[code]); }
    catch (error) { if (!partial) throw error; errors[code] = '报价缺失或格式无效'; }
  }
  return {
    provider: automaticProvider.id, source: automaticProvider.source, rates,
    at: new Date(at).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    fetchedAt: new Date(fetchedAt).toISOString(), ...(partial && { errors })
  };
}

export async function fetchFinanceQuote({ fetchQuote = globalThis.fetch, clock = Date.now,
  codes = currencies, partial = false, signal } = {}) {
  const response = await fetchQuote(endpoint, {
    redirect: 'error', headers: { Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000)
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error(response.status === 429 ? '来源请求受限，等待冷却后重试' : '汇率来源暂时不可用'), { status: response.status });
  }
  return readFinanceQuote(response, clock, codes, partial);
}

export function createFinanceQuoteService({
  provider = 'disabled', fetchQuote = globalThis.fetch, clock = Date.now, collection
} = {}) {
  if (provider !== 'disabled' && provider !== automaticProvider.id)
    throw new Error('未识别的自动汇率来源');
  if (collection) return {
    get enabled() { return collection.sourceEnabled; },
    snapshotFor: collection.snapshotFor,
    verifySnapshot: collection.verifySnapshot
  };
  const enabled = provider !== 'disabled';
  let cached;
  let inFlight;
  let retryAt = 0;
  let failure;

  function usableQuote() {
    const now = clock();
    return cached && now >= Date.parse(cached.fetchedAt) && now < Date.parse(cached.expiresAt)
      ? cached
      : null;
  }

  async function refresh() {
    let backoff = 60_000;
    try {
      cached = await fetchFinanceQuote({ fetchQuote, clock });
      return cached;
    } catch (error) {
      if (error.status === 429) backoff = 20 * 60_000;
      cached = undefined;
      failure = new Error('暂时没有完整且有效的自动报价');
      retryAt = clock() + backoff;
      throw failure;
    }
  }

  async function snapshotFor(order) {
    if (!enabled) throw new Error('尚未配置自动汇率来源');
    let quote = usableQuote();
    if (!quote) {
      if (!inFlight && clock() < retryAt) throw failure;
      inFlight ??= refresh().finally(() => { inFlight = undefined; });
      quote = await inFlight;
    }
    return createAutomaticOrderSnapshot(quote, order, clock());
  }

  function verifySnapshot(snapshot, order) {
    const quote = usableQuote();
    if (!enabled || !quote) return false;
    try {
      return isDeepStrictEqual(snapshot, createAutomaticOrderSnapshot(quote, order, clock()));
    } catch {
      return false;
    }
  }

  return { enabled, snapshotFor, verifySnapshot };
}
