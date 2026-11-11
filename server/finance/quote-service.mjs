import { isDeepStrictEqual } from 'node:util';

import {
  automaticProvider, createAutomaticOrderSnapshot, currencies, normalizeAutomaticProvider
} from '../../modules/finance/accounting.mjs';

const endpoints = [
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/cny.min.json',
  'https://latest.currency-api.pages.dev/v1/currencies/cny.min.json'
];
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data?.date) ||
      !data.cny || typeof data.cny !== 'object' || Array.isArray(data.cny))
    throw new Error('供应商报价格式无效');
  const at = Date.parse(data.date + 'T00:00:00.000Z');
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== data.date)
    throw new Error('供应商报价日期无效');
  const fetchedAt = clock(), expiresAt = at + maximumAge;
  if (!(at <= fetchedAt && fetchedAt < expiresAt)) throw new Error('供应商报价尚未生效或已过期');
  if (!/^1(?:\.0+)?$/.test(data.cny.cny)) throw new Error('供应商报价基准无效');
  const rates = { CNY: '1' }, errors = {};
  for (const code of codes.filter(code => code !== 'CNY')) {
    try { rates[code] = toCny(data.cny[code.toLowerCase()]); }
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
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000);
  for (let index = 0; index < endpoints.length; index++) {
    let response;
    try {
      response = await fetchQuote(endpoints[index], {
        redirect: 'error', headers: { Accept: 'application/json' }, signal: requestSignal
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error(response.status === 429 ? '来源请求受限，等待冷却后重试' : '汇率来源暂时不可用'), { status: response.status });
      }
    } catch (error) {
      // Both official endpoints share one timeout budget. Rate limits and aborts never trigger retries.
      if (index === endpoints.length - 1 || requestSignal.aborted || error.status === 429 ||
          ['AbortError', 'TimeoutError'].includes(error.name)) throw error;
      continue;
    }
    // Invalid data fails closed; never combine rates from separate responses.
    return readFinanceQuote(response, clock, codes, partial);
  }

}

export function createFinanceQuoteService({
  provider = 'disabled', fetchQuote = globalThis.fetch, clock = Date.now, collection
} = {}) {
  provider = normalizeAutomaticProvider(provider);
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
