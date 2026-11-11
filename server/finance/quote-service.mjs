import { isDeepStrictEqual } from 'node:util';

import {
  automaticProvider, createAutomaticOrderSnapshot, currencies, fallbackQuoteProvider, normalizeAutomaticProvider
} from '../../modules/finance/accounting.mjs';

const primaryEndpoint = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/cny.min.json';
const fallbackEndpoint = 'https://api.frankfurter.dev/v2/rates';
const sourceTimeout = 2_000;
export const quoteLimitCooldown = 20 * 60_000;
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

async function readQuoteBody(response) {
  // Preserve the provider's original JSON digits for exact reciprocal rounding.
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error('供应商响应过长');
  return JSON.parse(text, (_key, value, context) =>
    typeof value === 'number' ? context.source : value
  );
}

function buildQuote(provider, date, readRate, { clock, codes, partial = false }) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error('供应商报价日期无效');
  const at = Date.parse(date + 'T00:00:00.000Z');
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== date)
    throw new Error('供应商报价日期无效');
  const fetchedAt = clock(), expiresAt = at + maximumAge;
  if (!(at <= fetchedAt && fetchedAt < expiresAt)) throw new Error('供应商报价尚未生效或已过期');
  const rates = { CNY: '1' }, errors = {};
  for (const code of codes.filter(code => code !== 'CNY')) {
    try { rates[code] = toCny(readRate(code)); }
    catch (error) { if (!partial) throw error; errors[code] = '报价缺失或格式无效'; }
  }
  return {
    provider: provider.id, source: provider.source, rates,
    at: new Date(at).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    fetchedAt: new Date(fetchedAt).toISOString(), ...(partial && { errors })
  };
}

export async function readFinanceQuote(response, clock, codes = currencies, partial = false) {
  const data = await readQuoteBody(response);
  if (!data?.cny || typeof data.cny !== 'object' || Array.isArray(data.cny))
    throw new Error('供应商报价格式无效');
  if (!/^1(?:\.0+)?$/.test(data.cny.cny)) throw new Error('供应商报价基准无效');
  return buildQuote(automaticProvider, data.date, code => data.cny[code.toLowerCase()], { clock, codes, partial });
}

async function readFallbackQuote(response, clock, codes) {
  const rows = await readQuoteBody(response);
  const expected = new Set(codes.filter(code => code !== 'CNY'));
  if (!Array.isArray(rows) || !rows.length || rows.length !== expected.size)
    throw new Error('备用来源报价缺少所需币种');
  const date = rows[0]?.date;
  const rates = new Map();
  for (const row of rows) {
    if (row?.base !== 'CNY' || !expected.has(row.quote) || rates.has(row.quote))
      throw new Error('备用来源报价币种或基准无效');
    if (row.date !== date) throw new Error('备用来源报价日期不一致');
    rates.set(row.quote, row.rate);
  }
  return buildQuote(fallbackQuoteProvider, date, code => rates.get(code), { clock, codes });
}

async function requestQuote(url, readQuote, { fetchQuote, signal }) {
  const timeout = AbortSignal.timeout(sourceTimeout);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  requestSignal.throwIfAborted();
  const response = await fetchQuote(url, {
    redirect: 'error', headers: { Accept: 'application/json' }, signal: requestSignal
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error(response.status === 429 ? '来源请求受限，等待冷却后重试' : '汇率来源暂时不可用'), { status: response.status });
  }
  const quote = await readQuote(response);
  requestSignal.throwIfAborted();
  return quote;
}

export async function fetchFinanceQuote({ fetchQuote = globalThis.fetch, clock = Date.now,
  codes = currencies, partial = false, signal } = {}) {
  let partialQuote, primaryError;
  try {
    const quote = await requestQuote(primaryEndpoint, response => readFinanceQuote(response, clock, codes, partial), { fetchQuote, signal });
    if (!Object.keys(quote.errors ?? {}).length) return quote;
    partialQuote = quote;
  } catch (error) {
    primaryError = error;
  }
  signal?.throwIfAborted();
  const url = new URL(fallbackEndpoint);
  url.search = new URLSearchParams({ base: 'CNY', quotes: codes.filter(code => code !== 'CNY').join(',') });
  try {
    const quote = await requestQuote(url.href, response => readFallbackQuote(response, clock, codes), { fetchQuote, signal });
    return { ...quote, ...(partial && { errors: {} }), ...(primaryError?.status === 429 && { rateLimited: true }) };
  } catch (error) {
    signal?.throwIfAborted();
    // Preserve a valid partial primary batch without mixing its rates with backup data.
    if (partialQuote && clock() < Date.parse(partialQuote.expiresAt))
      return error.status === 429 ? { ...partialQuote, rateLimited: true } : partialQuote;
    throw primaryError?.status === 429 ? primaryError : error;
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
    try {
      cached = await fetchFinanceQuote({ fetchQuote, clock });
      retryAt = cached.rateLimited ? clock() + quoteLimitCooldown : 0;
      failure = cached.rateLimited ? new Error('来源请求受限，等待冷却后重试') : undefined;
      return cached;
    } catch (error) {
      cached = undefined;
      failure = new Error('暂时没有完整且有效的自动报价');
      retryAt = clock() + (error.status === 429 ? quoteLimitCooldown : 60_000);
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
