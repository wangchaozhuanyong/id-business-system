import { createHash } from 'node:crypto';
import { automaticProvider, currencies, normalizeAutomaticProvider } from '../../modules/finance/accounting.mjs';

export const collectionDomain = 'finance-rates';
export const hour = 3_600_000;
export const day = 24 * hour;
export const collectionError = (status, message) => Object.assign(new Error(message), { status });
export const defaults = (provider = 'disabled') => ({
  version: 1, provider: normalizeAutomaticProvider(provider), enabled: true, schedule: 'source', intervalMinutes: 1440,
  currencies: currencies.filter(code => code !== 'CNY'), quoteRetentionDays: 365,
  runRetentionDays: 90, retryAttempts: 3
});

export function validateSettings(input) {
  const allowed = Object.keys(defaults()).filter(key => key !== 'version');
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !allowed.includes(key))) throw collectionError(400, '采集设置格式无效');
  input = { ...input, provider: normalizeAutomaticProvider(input.provider) };
  if (![automaticProvider.id, 'disabled'].includes(input.provider) || typeof input.enabled !== 'boolean' ||
      !['source', 'interval'].includes(input.schedule)) throw collectionError(400, '请选择有效的来源和采集方式');
  for (const [key, min, max, label] of [
    ['intervalMinutes', 60, 10080, '采集间隔应为 60–10080 分钟'],
    ['quoteRetentionDays', 7, 3650, '报价保留时间应为 7–3650 天'],
    ['runRetentionDays', 7, 365, '记录保留时间应为 7–365 天'],
    ['retryAttempts', 0, 3, '失败重试应为 0–3 次']
  ]) if (!Number.isSafeInteger(input[key]) || input[key] < min || input[key] > max) throw collectionError(400, label);
  if (!Array.isArray(input.currencies) || !input.currencies.length ||
      input.currencies.some(code => !currencies.includes(code) || code === 'CNY') ||
      new Set(input.currencies).size !== input.currencies.length) throw collectionError(400, '至少选择一个有效币种，不能重复选择');
  return { ...input, currencies: currencies.filter(code => input.currencies.includes(code)) };
}

export const quoteId = quote => 'fxq-' + createHash('sha256').update(JSON.stringify([
  quote.provider, quote.at, quote.expiresAt,
  Object.entries(quote.rates).sort(([a], [b]) => a.localeCompare(b))
])).digest('hex');

export function cleanupPlan(document, orders, now) {
  const protectedIds = new Set(), protectedTimes = new Set();
  for (const { fxSnapshot: snapshot } of orders || []) if (snapshot) {
    if (snapshot.quoteId) protectedIds.add(snapshot.quoteId);
    else protectedTimes.add(JSON.stringify([snapshot.source, snapshot.at]));
  }
  const quotes = document.quotes.filter(quote => Date.parse(quote.expiresAt) < now - document.settings.quoteRetentionDays * day &&
    !protectedIds.has(quote.id) && !protectedTimes.has(JSON.stringify([quote.source, quote.at]))).map(quote => quote.id).sort();
  const runs = document.runs.filter(run => run.status !== 'running' &&
    Date.parse(run.finishedAt || run.startedAt) < now - document.settings.runRetentionDays * day).map(run => run.id).sort();
  return { quotes, runs, token: createHash('sha256').update(JSON.stringify([quotes, runs])).digest('hex') };
}

export function collectionMetrics(runs, now) {
  return [7, 30].map(days => {
    const recent = runs.filter(run => run.status !== 'running' && Date.parse(run.startedAt) >= now - days * day);
    const success = recent.filter(run => ['updated', 'unchanged'].includes(run.status)).length;
    const elapsed = recent.map(run => run.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
    return { days, total: recent.length, success, failed: recent.length - success,
      successPercent: recent.length ? (success * 100 / recent.length).toFixed(1) : null,
      p95Ms: elapsed.length ? elapsed[Math.ceil(elapsed.length * 0.95) - 1] : null };
  });
}
