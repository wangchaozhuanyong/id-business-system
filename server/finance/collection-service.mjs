import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  automaticProvider, compareQuoteRecency, createAutomaticOrderSnapshot, isAutomaticQuote,
  normalizeAutomaticProvider, orderAccountingAt, requiredQuoteCurrencies
} from '../../modules/finance/accounting.mjs';
import { fetchFinanceQuote, quoteLimitCooldown } from './quote-service.mjs';
import { collectionDomain, collectionError, defaults, validateSettings, quoteId, cleanupPlan, collectionMetrics, hour, day } from './collection-policy.mjs';

const iso = time => new Date(time).toISOString();
const systemActor = { id: 'finance-collector', name: '汇率采集任务', role: 'admin' };
const orderTime = (order) => {
  const at = orderAccountingAt(order) || '';
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(at) ? at : at.replace(' ', 'T') + '+08:00');
};

export function createFinanceCollection({ store, provider = 'disabled', fetchQuote = globalThis.fetch,
  clock = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  provider = normalizeAutomaticProvider(provider);
  if (!['disabled', automaticProvider.id].includes(provider)) throw new Error('未识别的自动汇率来源');
  let inFlight, timer, started = false, closed = false;
  const shutdown = new AbortController();
  function read() {
    const current = store.featureDocument(collectionDomain);
    const data = current.data && { ...current.data, settings: { ...current.data.settings,
      provider: normalizeAutomaticProvider(current.data.settings.provider) } };
    return { version: current.version, data: data || { settings: defaults(provider), quotes: [], runs: [], settingChanges: [],
      state: { nextRunAt: null, retryAt: null, cooldownUntil: null, failures: 0, active: null, lastSuccessAt: null, lastRequestAt: null } } };
  }
  function update(mutate, audit) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = read(), next = structuredClone(current.data);
      const value = mutate(next, current.version);
      if (value === false) return current;
      try {
        return store.saveFeatureDocument(collectionDomain, current.version, next, audit);
      } catch (error) { if (error.status !== 409 || attempt === 2) throw error; }
    }
  }
  const orders = () => store.load('commerce').data?.orders || [];
  function dueAt({ state, quotes }, now) {
    const at = state.active?.expiresAt || state.retryAt || state.nextRunAt;
    let due = at ? Date.parse(at) : now;
    if (state.cooldownUntil) due = Math.max(due, Date.parse(state.cooldownUntil));
    const latest = [...quotes].sort(compareQuoteRecency)[0];
    if (!state.active && !state.failures && latest && state.lastRequestAt && Date.parse(latest.expiresAt) > now)
      due = Math.max(due, Math.min(Date.parse(state.lastRequestAt) + hour, Date.parse(latest.expiresAt)));
    return due;
  }
  function schedule() {
    clearTimer(timer);
    if (!started || closed) return;
    const data = read().data;
    if (!data.state.active && (!data.settings.enabled || data.settings.provider === 'disabled')) return;
    const due = dueAt(data, clock());
    timer = setTimer(() => {
      timer = undefined;
      void collect('automatic').catch(() => {}).finally(schedule);
    }, Math.min(2_147_000_000, Math.max(10, due - clock())));
    timer?.unref?.();
  }
  function nextRegular(settings, quote, now) {
    if (settings.schedule !== 'source') return iso(now + settings.intervalMinutes * 60_000);
    if (!quote) return iso(now + day);
    // Daily publication may lag midnight; retry stale-but-valid dates at most hourly.
    return iso(Math.min(Date.parse(quote.expiresAt), Math.max(Date.parse(quote.at) + day, now + hour)));
  }
  function recoverExpired() {
    update(data => {
      const active = data.state.active;
      if (!active || Date.parse(active.expiresAt) > clock()) return false;
      const run = data.runs.find(run => run.id === active.id);
      if (run) Object.assign(run, { status: 'failed', finishedAt: iso(clock()),
        error: '上次任务中断，已恢复调度', durationMs: Math.max(0, clock() - Date.parse(run.startedAt)) });
      data.state.active = null;
      data.state.failures++;
      data.state.retryAt = null;
      data.state.nextRunAt = iso(clock());
    }, { action: '恢复中断的汇率采集', actor: systemActor });
  }
  async function execute(mode, actor) {
    if (closed) throw collectionError(503, '采集服务已停止');
    recoverExpired();
    const now = clock(), id = 'fxr-' + randomUUID();
    let settings;
    update(data => {
      settings = structuredClone(data.settings);
      if (settings.provider === 'disabled') throw collectionError(409, '请先在采集设置中启用汇率来源');
      if (mode !== 'manual' && !settings.enabled) throw collectionError(409, '自动采集已暂停');
      if (data.state.active) throw collectionError(409, '已有采集任务运行，请等待完成');
      const due = data.state.retryAt || data.state.nextRunAt;
      if (mode === 'automatic' && due && Date.parse(due) > now) return false;
      if (data.state.retryAt && Date.parse(data.state.retryAt) > now)
        throw collectionError(429, '正在等待来源冷却，请按运行状态中的时间重试');
      if (data.state.cooldownUntil && Date.parse(data.state.cooldownUntil) > now)
        throw collectionError(429, '来源限流冷却尚未结束，请稍后重试');
      const latest = [...data.quotes].sort(compareQuoteRecency)[0];
      if (data.state.lastRequestAt && now - Date.parse(data.state.lastRequestAt) < hour &&
          latest && now < Date.parse(latest.expiresAt) && !data.state.failures)
        throw collectionError(429, '最近一小时已采集，当前报价仍有效；请稍后再采集');
      data.state.active = { id, expiresAt: iso(now + 30_000) };
      data.state.lastRequestAt = iso(now);
      data.runs.unshift({ id, mode, status: 'running', actorId: actor.id, actorName: actor.name,
        settingsVersion: settings.version, currencies: settings.currencies, startedAt: iso(now),
        updatedCount: 0, errors: {}, quoteId: null });
    }, { action: mode === 'manual' ? '手动采集汇率' : '自动采集汇率', actor, targetId: id });
    // Another scheduler may already have completed the due task.
    if (read().data.state.active?.id !== id) return { skipped: true };
    let quote, failure;
    try { quote = await fetchFinanceQuote({ fetchQuote, clock, codes: settings.currencies, partial: true, signal: shutdown.signal }); }
    catch (error) { failure = error; }
    if (closed) throw collectionError(503, '采集服务已停止');
    const finished = clock();
    const saved = update(data => {
      if (data.state.active?.id !== id) throw collectionError(409, '采集任务所有权已变化，结果未覆盖');
      const run = data.runs.find(run => run.id === id);
      Object.assign(run, { finishedAt: iso(finished), durationMs: Math.max(0, finished - now) });
      let limited = failure?.status === 429;
      if (failure) {
        run.status = 'failed';
        run.error = failure.status === 429 ? '来源请求受限，等待冷却后重试' : '汇率来源请求或报价校验失败';
      } else {
        const { errors, rateLimited, ...values } = quote;
        limited = rateLimited === true;
        const id = quoteId(values), previous = data.quotes.find(item => item.id === id);
        run.quoteId = Object.keys(values.rates).length > 1 ? id : null;
        run.errors = errors;
        run.updatedCount = previous ? 0 : Object.keys(values.rates).length - 1;
        run.status = Object.keys(errors).length ? 'partial' : previous ? 'unchanged' : 'updated';
        if (Object.keys(values.rates).length > 1) {
          if (previous) previous.lastSeenAt = values.fetchedAt;
          else data.quotes.unshift({ id, ...values, lastSeenAt: values.fetchedAt });
        }
      }
      const okay = ['updated', 'unchanged'].includes(run.status);
      data.state.active = null;
      data.state.failures = okay ? 0 : data.state.failures + 1;
      const delay = limited ? quoteLimitCooldown : [60_000, 5 * 60_000, 15 * 60_000][Math.min(Math.max(data.state.failures - 1, 0), 2)];
      if (!okay || limited) data.state.cooldownUntil = iso(Math.max(Date.parse(data.state.cooldownUntil || '') || 0,
        finished + delay));
      else data.state.cooldownUntil = null;
      if (okay) data.state.lastSuccessAt = iso(finished);
      // Configuration edited during the request keeps its newer schedule.
      if (data.settings.version === settings.version) {
        const attempts = data.state.failures;
        data.state.retryAt = !okay && attempts <= settings.retryAttempts ? iso(finished + delay) : null;
        data.state.nextRunAt = nextRegular(settings, quote, finished);
        if (!okay && !data.state.retryAt) data.state.nextRunAt = iso(finished + (settings.schedule === 'source' ? day : settings.intervalMinutes * 60_000));
      }
    }, { action: '记录汇率采集结果', actor, targetId: id });
    return { run: saved.data.runs.find(run => run.id === id) };
  }
  function collect(mode = 'manual', actor = systemActor) {
    if (!['automatic', 'manual', 'order'].includes(mode)) return Promise.reject(collectionError(400, '采集方式无效'));
    if (inFlight) return inFlight;
    inFlight = execute(mode, actor).finally(() => { inFlight = undefined; schedule(); });
    return inFlight;
  }
  function saveSettings(version, input, actor) {
    const valid = validateSettings(input);
    const saved = update(data => {
      if (data.settings.version !== version) throw collectionError(409, '采集设置已更新，请核对最新版本，当前输入已保留');
      const before = structuredClone(data.settings);
      data.settings = { ...valid, version: version + 1 };
      (data.settingChanges ||= []).unshift({ id: 'fxs-' + randomUUID(), at: iso(clock()),
        actorId: actor.id, actorName: actor.name, before, after: data.settings, currencies: valid.currencies });
      // Never bypass an existing upstream cooldown or active-task lease.
      data.state.nextRunAt = iso(clock());
    }, { action: '修改汇率采集设置', actor });
    schedule();
    return saved.data.settings;
  }
  function planCleanup() {
    const { version, data } = read(), at = clock();
    const plan = cleanupPlan(data, orders(), at);
    return { version, at: iso(at), token: plan.token, quoteCount: plan.quotes.length, runCount: plan.runs.length };
  }
  function cleanup(preview, actor) {
    if (!preview || !Number.isSafeInteger(preview.version) || !Number.isFinite(Date.parse(preview.at)) ||
        clock() - Date.parse(preview.at) < 0 || clock() - Date.parse(preview.at) > 5 * 60_000)
      throw collectionError(409, '清理预览已过期，请重新预览');
    const commerce = store.load('commerce');
    const saved = update((data, version) => {
      if (version !== preview.version || data.state.active) throw collectionError(409, '记录已更新或正在采集，请重新预览');
      const plan = cleanupPlan(data, commerce.data?.orders || [], Date.parse(preview.at));
      if (plan.token !== preview.token) throw collectionError(409, '待清理范围已变化，请重新预览');
      data.quotes = data.quotes.filter(quote => !plan.quotes.includes(quote.id));
      data.runs = data.runs.filter(run => !plan.runs.includes(run.id));
    }, { action: '清理过期汇率采集记录', actor, commerceVersion: commerce.version });
    return { version: saved.version };
  }
  function compatible(data, order) {
    const at = orderTime(order), required = requiredQuoteCurrencies(order);
    return data.quotes.filter(quote => isAutomaticQuote(quote) && Date.parse(quote.at) <= at &&
      at < Date.parse(quote.expiresAt) && required.every(code => Object.hasOwn(quote.rates, code)))
      .sort(compareQuoteRecency)[0];
  }
  async function snapshotFor(order) {
    let data = read().data;
    if (data.settings.provider === 'disabled') throw collectionError(409, '汇率来源尚未启用，请前往系统设置 → 汇率采集');
    let quote = compatible(data, order);
    if (!quote) {
      if (!data.settings.enabled) throw collectionError(422, '没有匹配报价且自动采集已暂停，请手动采集或登记凭据');
      const missing = requiredQuoteCurrencies(order).filter(code => !data.settings.currencies.includes(code));
      if (missing.length) throw collectionError(422, '当前采集设置未包含订单所需币种：' + missing.join('、'));
      await collect('order');
      data = read().data;
      quote = compatible(data, order);
    }
    if (!quote) throw collectionError(422, '没有覆盖订阅时点的有效历史报价，请保留待核算或登记原凭据');
    return createAutomaticOrderSnapshot({ ...quote, quoteId: quote.id }, order, clock(), { historical: true });
  }
  function verifySnapshot(snapshot, order) {
    const { data } = read();
    const quote = data.quotes.find(quote => quote.id === snapshot?.quoteId);
    if (!quote || data.settings.provider === 'disabled') return false;
    try { return isDeepStrictEqual(snapshot, createAutomaticOrderSnapshot({ ...quote, quoteId: quote.id }, order, clock(), { historical: true })); }
    catch { return false; }
  }
  function view({ tab = 'rates', query = '', currency = '', status = '', mode = '', from = '', to = '',
    page = 1, pageSize = 8 } = {}) {
    const { version, data } = read(), now = clock();
    const sorted = [...data.quotes].sort(compareQuoteRecency);
    const rates = data.settings.currencies.map(code => {
      const quote = sorted.find(quote => quote.rates[code]);
      return { id: code, currency: code, rate: quote?.rates[code] || null, source: quote?.source || null,
        quoteId: quote?.id || null, at: quote?.at || null, fetchedAt: quote?.lastSeenAt || null,
        expiresAt: quote?.expiresAt || null, status: !quote ? 'missing' : now >= Date.parse(quote.expiresAt) ? 'expired' : 'valid' };
    });
    let rows = tab === 'settings-history' ? data.settingChanges || [] : tab === 'runs' ? data.runs
      : tab === 'history' ? sorted.filter(quote => !currency || quote.rates[currency]) : rates;
    const needle = String(query).toLocaleLowerCase().trim();
    const start = from ? Date.parse(from + 'T00:00:00+08:00') : -Infinity;
    const end = to ? Date.parse(to + 'T00:00:00+08:00') + day : Infinity;
    rows = rows.filter(row => (!currency || row.currency === currency || row.currencies?.includes(currency) || row.rates?.[currency]) &&
      (!status || row.status === status) && (!mode || row.mode === mode) &&
      (!needle || [row.id, row.currency, row.actorName, ...(row.currencies || []), row.error, row.source].some(value => String(value || '').toLocaleLowerCase().includes(needle))) &&
      Date.parse(row.startedAt || row.at || iso(now)) >= start && Date.parse(row.startedAt || row.at || iso(now)) < end);
    const total = rows.length, actualPage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
    const cleanup = cleanupPlan(data, orders(), now);
    return { version, now: iso(now), nextExpiryAt: rates.filter(rate => rate.status === 'valid')
      .map(rate => rate.expiresAt).sort()[0] || null, settings: data.settings, state: data.state, provider: automaticProvider,
      rows: rows.slice((actualPage - 1) * pageSize, actualPage * pageSize), total, page: actualPage, pageSize,
      validCount: rates.filter(rate => rate.status === 'valid').length, currencyCount: rates.length,
      metrics: collectionMetrics(data.runs, now), cleanup: { quoteCount: cleanup.quotes.length, runCount: cleanup.runs.length },
      scheduledAt: data.settings.enabled && data.settings.provider !== 'disabled' ? iso(Math.max(now, dueAt(data, now))) : null,
      latest: data.runs[0] || null };
  }
  return {
    get sourceEnabled() { return read().data.settings.provider !== 'disabled'; },
    read, view, collect, saveSettings, planCleanup, cleanup, snapshotFor, verifySnapshot,
    start() { if (!closed) { started = true; schedule(); } },
    close() { closed = true; started = false; clearTimer(timer); shutdown.abort(); }
  };
}
