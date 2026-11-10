import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  monitorRules, monitorChannels, monitorConfigDomain, monitorStateDomain, legacyRules, initialMonitoringConfig,
  taskMonitorRules, scopePattern, chatIdPattern, botTokenPattern, boundedCount, monitoringError, telegramText, sendTelegram
} from './monitoring-policy.mjs';

const limit = 1000;
const minute = 60_000;
const transient = new Set(['queued', 'sending']);
const stateDefaults = () => ({ incidents: [], deliveries: [], verifiedBindings: {}, telegramRetryAt: 0 });
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

function updateBindings(previous, settings) {
  return Object.fromEntries(Object.entries(settings.channels).map(([target, chatId]) => [target,
    (settings.token === previous.token && chatId === previous.channels[target] && previous.bindings[target]) || randomUUID()]));
}

function checkDestinations(channels) {
  if (channels.rechargeGroup && [channels.security, channels.operations].includes(channels.rechargeGroup))
    throw monitoringError(422, '代充群组须与安全和运维接收人分开');
}

function pageOf(rows, requested, pageSize) {
  const total = rows.length;
  const page = Math.min(requested, Math.max(1, Math.ceil(total / pageSize)));
  return { items: rows.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total };
}

export function createSystemMonitoring({ store, origin, native, clock = Date.now, send = sendTelegram }) {
  const samples = new Map();
  let dispatching = false;
  let transferring = false;
  let closed = false;
  let timer;
  let lastProbeAt = 0;
  let lastSentAt = -Infinity;

  function config() {
    const row = store.featureDocument(monitorConfigDomain);
    return { version: row.version, data: row.data || initialMonitoringConfig() };
  }

  function state() {
    const row = store.featureDocument(monitorStateDomain);
    return { version: row.version, data: row.data || stateDefaults() };
  }

  function updateState(update, audit) {
    const { version, data } = state();
    const result = update(data);
    if (result === false) return false;
    const keep = data.incidents.filter(row => !row.resolvedAt && !monitorRules[row.code].oneShot);
    const history = data.incidents.filter(row => row.resolvedAt || monitorRules[row.code].oneShot);
    data.incidents = [...keep, ...history.slice(0, limit)].sort((a, b) => b.at - a.at);
    data.deliveries = [...data.deliveries.filter(row => transient.has(row.status)),
      ...data.deliveries.filter(row => !transient.has(row.status)).slice(0, limit)].sort((a, b) => b.at - a.at);
    store.saveFeatureDocument(monitorStateDomain, version, data, audit);
    return result;
  }

  function checkedConfig(version) {
    const current = config();
    if (current.version !== version) throw monitoringError(409, '设置版本已更新，请刷新后核对草稿');
    return current.data;
  }

  function verified(data, settings, target) {
    const binding = settings.bindings[target];
    return Boolean(binding && data.verifiedBindings?.[target] === binding);
  }

  function configView() {
    const { version, data: settings } = config();
    const { data } = state();
    return { version, enabled: settings.enabled, tokenConfigured: Boolean(settings.token),
      channels: Object.fromEntries(Object.entries(monitorChannels).map(([key, label]) => [key, {
        label, configured: Boolean(settings.channels[key]), verified: verified(data, settings, key)
      }])),
      rules: Object.entries(monitorRules).map(([code, { label, category, priority, failures, channel }]) =>
        ({ code, label, category, priority, failures, enabled: settings.rules[code],
          recipient: channel === 'legacy' ? '已接管的代充接收人' : monitorChannels[channel === 'recharge' ? 'rechargeAdmin' : channel] })),
      legacy: { phase: settings.legacy.phase, imported: Boolean(settings.legacy.snapshot),
        available: Boolean(native), since: settings.legacy.since || null, recipients: [...settings.legacy.recipients] }
    };
  }

  function noticeTargets(data, settings, code) {
    if (!settings.enabled || !settings.rules[code]) return [];
    const { channel } = monitorRules[code];
    const candidates = channel === 'legacy' ? settings.legacy.phase === 'managed' ? settings.legacy.recipients : []
      : channel === 'recharge' ? ['rechargeAdmin'] : [channel];
    const seen = new Set();
    return candidates.filter(target => {
      const chat = settings.channels[target];
      if (!verified(data, settings, target) || seen.has(chat)) return false;
      seen.add(chat);
      return true;
    });
  }

  function enqueue(data, settings, incident, kind, at) {
    if (data.deliveries.filter(row => transient.has(row.status)).length >= limit) {
      incident.queueFull = true;
      return;
    }
    const targets = noticeTargets(data, settings, incident.code);
    for (const target of targets) {
      if (kind === 'recovered' && !data.deliveries.some(row => row.incidentId === incident.id &&
          row.target === target && row.binding === settings.bindings[target] &&
          row.kind === 'opened' && ['accepted', 'queued', 'sending', 'unknown'].includes(row.status))) continue;
      data.deliveries.unshift({
        id: randomUUID(), incidentId: incident.id, code: incident.code, scope: incident.scope,
        count: kind === 'opened' ? incident.count : null, summary: incident.summary, kind, target, binding: settings.bindings[target],
        status: 'queued', attempts: 0, at, due: at
      });
    }
  }

  function normalizedSample(input, now) {
    const { code, scope = 'system', status, at = now, external = false, confirmed = false } = input;
    const rule = Object.hasOwn(monitorRules, code) && monitorRules[code];
    if (!rule || typeof scope !== 'string' || !scopePattern.test(scope) ||
        !['bad', 'ok', 'unknown', 'disabled'].includes(status) ||
        !Number.isSafeInteger(at) || at <= 0 || at > now + minute) return null;
    const count = boundedCount(input.count);
    const summary = code === 'digest' && input.summary &&
      ['success', 'failure', 'review', 'open'].every(key => boundedCount(input.summary[key]) !== null)
      ? Object.fromEntries(['success', 'failure', 'review', 'open'].map(key => [key, input.summary[key]])) : undefined;
    return { code, scope, status, at, external, confirmed: external && confirmed,
      accepted: external && input.accepted === true, externalId: external ? input.externalId : undefined,
      count, summary, rule, key: code + ':' + scope };
  }

  function observe(inputs, audit) {
    if (closed) return false;
    const now = clock();
    const current = inputs.map(input => normalizedSample(input, now)).filter(Boolean);
    const { data: settings } = config();
    const nextSamples = new Map(samples);
    const changed = updateState(data => {
      let dirty = false;
      for (const item of current) {
        const { key, code, scope, status, count, at, external, confirmed, accepted, externalId, rule, summary } = item;
        const last = nextSamples.get(key);
        if (last && at <= last.at && !confirmed) continue;
        const streak = last?.status === status && at - last.at <= 3 * minute ? last.streak + 1 : 1;
        if (!rule.oneShot && (!last || at > last.at)) nextSamples.set(key, { code, status, streak, at });
        if (legacyRules.includes(code) && settings.legacy.phase !== 'managed') continue;
        if (rule.oneShot && !settings.rules[code] && ['digest', ...legacyRules].includes(code)) continue;
        const active = data.incidents.find(row => row.code === code && row.scope === scope &&
          (!row.resolvedAt || (code === 'public_site' && scope !== 'system')));
        if (active) {
          if (accepted && !active.externalAccepted) {
            active.externalAccepted = true;
            dirty = true;
          }
          if (!rule.oneShot && !active.resolvedAt && status === 'ok' && (confirmed || streak >= 2)) {
            active.resolvedAt = at;
            if (!external) enqueue(data, settings, active, 'recovered', at);
            dirty = true;
          } else if (status === 'bad' && count !== null && active.count !== count) {
            active.count = count;
            dirty = true;
          }
          continue;
        }
        if (status !== 'bad' || (!confirmed && streak < rule.failures)) continue;
        const id = externalId && !data.incidents.some(row => row.id === externalId) ? externalId : randomUUID();
        const incident = { id, code, scope, at, count, summary, external, externalAccepted: accepted };
        data.incidents.unshift(incident);
        if (!external) enqueue(data, settings, incident, 'opened', at);
        dirty = true;
      }
      return dirty;
    }, audit);
    for (const [key, sample] of nextSamples) {
      if (now - sample.at > 15 * minute) nextSamples.delete(key);
    }
    samples.clear();
    for (const [key, sample] of nextSamples) samples.set(key, sample);
    if (changed) kick();
    return changed;
  }

  function receiveProbe({ at, status, certificateDays, incident }) {
    if (at <= lastProbeAt) return;
    const items = [{ code: 'tls_expiry', status: certificateDays === null ? 'unknown' : certificateDays <= 14 ? 'bad' : 'ok',
      count: certificateDays, at }, { code: 'external_probe', status: 'ok', at }];
    if (incident) {
      const scope = 'probe-' + incident.at;
      items.push({ code: 'public_site', scope, status: 'bad', at: incident.at, external: true,
        confirmed: true, accepted: incident.accepted, externalId: incident.id });
      if (incident.recoveredAt) items.push({ code: 'public_site', scope, status: 'ok', at: incident.recoveredAt,
        external: true, confirmed: true });
    }
    items.push({ code: 'public_site', status: status === 'bad' ? 'unknown' : status, at, external: true });
    observe(items);
    lastProbeAt = at;
  }

  function save(version, input, actor) {
    const previous = checkedConfig(version);
    if (previous.legacy.phase === 'switching') throw monitoringError(409, '请先完成代充通知接管核对');
    if (!object(input) || Object.keys(input).some(key => !['enabled', 'token', 'channels', 'rules', 'legacyRecipients'].includes(key)) ||
        typeof input.enabled !== 'boolean' || !object(input.channels) || !object(input.rules) ||
        (input.token !== undefined && input.token !== null &&
          (typeof input.token !== 'string' || !botTokenPattern.test(input.token))))
      throw monitoringError(400, 'Telegram 设置格式无效');
    const next = { ...previous, enabled: input.enabled, channels: { ...previous.channels },
      token: input.token === undefined ? previous.token : input.token || '', rules: { ...previous.rules } };
    if (input.legacyRecipients !== undefined) {
      if (previous.legacy.phase !== 'managed' || !Array.isArray(input.legacyRecipients) || input.legacyRecipients.length > 2 ||
          !input.legacyRecipients.every(value => ['rechargeAdmin', 'rechargeGroup'].includes(value)))
        throw monitoringError(400, '原代充接收范围无效');
      next.legacy = { ...previous.legacy, recipients: [...new Set(input.legacyRecipients)] };
    }
    for (const [key, value] of Object.entries(input.channels)) {
      if (!Object.hasOwn(monitorChannels, key) || (value !== null && (typeof value !== 'string' || !chatIdPattern.test(value))))
        throw monitoringError(400, '请填写有效的数字接收编号');
      if (value === null) delete next.channels[key];
      else next.channels[key] = value;
    }
    for (const [key, value] of Object.entries(input.rules)) {
      if (!Object.hasOwn(monitorRules, key) || key === 'public_site' || typeof value !== 'boolean' || (previous.legacy.snapshot &&
          previous.legacy.phase !== 'managed' && legacyRules.includes(key)))
        throw monitoringError(400, '告警规则无效或正在等待代充接管');
      next.rules[key] = value;
    }
    checkDestinations(next.channels);
    next.bindings = updateBindings(previous, next);
    if (next.enabled && (!next.token || !Object.keys(next.channels).some(target => verified(state().data, next, target))))
      throw monitoringError(422, '请先保存渠道并取得至少一个接收人的测试回执，再启用自动发送');
    if (isDeepStrictEqual(previous, next)) return configView();
    store.saveFeatureDocument(monitorConfigDomain, version, next, { action: 'monitor_settings', actor });
    // A settings change is already durable and audited, even when signal storage is unavailable.
    try { observe([{ code: 'channel_change', scope: 'setting-' + (version + 1), status: 'bad' }]); } catch {}
    return configView();
  }

  async function importLegacy(version, actor) {
    if (!native) throw monitoringError(422, '尚未连接原代充服务');
    const previous = checkedConfig(version);
    if (previous.legacy.phase !== 'native') throw monitoringError(409, '代充通知正在接管或已经接管');
    const { snapshot } = await native.read();
    checkedConfig(version);
    const { recipients, switches, adminChat, groupChat } = snapshot;
    const channels = { ...previous.channels };
    if (recipients.includes('rechargeAdmin')) channels.rechargeAdmin = adminChat;
    if (recipients.includes('rechargeGroup')) channels.rechargeGroup = groupChat;
    checkDestinations(channels);
    const rules = { ...previous.rules, ...Object.fromEntries(legacyRules.map((key, i) => [key, switches[i]])) };
    const bindings = updateBindings(previous, { ...previous, channels });
    store.saveFeatureDocument(monitorConfigDomain, version, { ...previous, channels, rules, bindings,
      legacy: { phase: 'native', recipients, snapshot } }, { action: 'monitor_legacy_import', actor });
    return configView();
  }

  async function takeOver(version, actor) {
    if (!native || transferring) throw monitoringError(409, '代充接管暂不可用，请先核对当前状态');
    let settings = checkedConfig(version);
    const snapshot = settings.legacy.snapshot;
    if (!snapshot || settings.legacy.phase === 'managed') throw monitoringError(409, '请先导入原代充通知设置');
    const activeSwitches = snapshot.switches.some(Boolean) && snapshot.recipients.length > 0;
    const targetsMatch = snapshot.recipients.every(target => settings.channels[target] ===
      (target === 'rechargeAdmin' ? snapshot.adminChat : snapshot.groupChat));
    if (activeSwitches && (!targetsMatch || !settings.enabled ||
        snapshot.recipients.some(target => !verified(state().data, settings, target))))
      throw monitoringError(422, '请核对原接收人、测试回执和统一发送开关');
    transferring = true;
    try {
      const current = await native.read();
      if (!current.idle) throw monitoringError(409, '请在原代充维护模式且无活动任务时接管');
      settings = checkedConfig(version);
      const cleared = { ...snapshot, switches: snapshot.switches.map(() => false) };
      if (!isDeepStrictEqual(current.snapshot, snapshot) &&
          !(settings.legacy.phase === 'switching' && isDeepStrictEqual(current.snapshot, cleared)))
        throw monitoringError(409, '原代充通知设置已改变，请重新核对后导入');
      if (settings.legacy.phase !== 'switching') {
        const next = { ...settings, legacy: { ...settings.legacy, phase: 'switching' } };
        ({ version, data: settings } = store.saveFeatureDocument(monitorConfigDomain, version, next,
          { action: 'monitor_legacy_begin', actor }));
      }
      if (current.snapshot.switches.some(Boolean)) await native.disable(snapshot);
      const receipt = await native.read();
      if (!receipt.idle || !isDeepStrictEqual(receipt.snapshot, cleared))
        throw monitoringError(503, '原代充发送关闭尚未确认，请核对后继续接管');
      store.saveFeatureDocument(monitorConfigDomain, version, { ...settings,
        legacy: { ...settings.legacy, phase: 'managed', since: clock() } }, { action: 'monitor_legacy_finish', actor });
      return configView();
    } finally { transferring = false; }
  }

  function queueTest(version, target, actor) {
    const settings = checkedConfig(version);
    if (!Object.hasOwn(monitorChannels, target) || !settings.token || !settings.channels[target])
      throw monitoringError(422, '请先保存 Telegram 密钥和该接收编号');
    const at = clock();
    updateState(data => {
      if (data.deliveries.some(row => row.kind === 'test' && row.target === target &&
          (transient.has(row.status) || at - row.at < minute)))
        throw monitoringError(429, '该接收人已有测试待处理或刚刚测试，请查看投递记录');
      data.deliveries.unshift({ id: randomUUID(), target, binding: settings.bindings[target],
        kind: 'test', status: 'queued', attempts: 0, at, due: at });
      return true;
    }, { action: 'monitor_test', actor, targetId: target });
    kick();
    return { queued: true };
  }

  async function dispatch() {
    if (closed || dispatching || clock() - lastSentAt < 1000) return false;
    dispatching = true;
    try {
      const at = clock();
      const settings = config().data;
      let row;
      updateState(data => {
        let dirty = false;
        for (const item of data.deliveries) {
          if (item.status === 'sending' && at - item.startedAt >= 20_000) {
            Object.assign(item, { status: 'unknown', reason: 'unconfirmed', finishedAt: at });
            dirty = true;
          }
        }
        if (at < data.telegramRetryAt) return dirty;
        row = data.deliveries.filter(item => item.status === 'queued' && item.due <= at)
          .sort((a, b) => Number(monitorRules[b.code]?.priority === 'P0') -
            Number(monitorRules[a.code]?.priority === 'P0') || a.at - b.at)[0];
        if (!row) return dirty;
        const permitted = settings.token && settings.channels[row.target] && row.binding === settings.bindings[row.target] &&
          (row.kind === 'test' || noticeTargets(data, settings, row.code).includes(row.target));
        if (!permitted) {
          Object.assign(row, { status: 'cancelled', reason: 'configuration', finishedAt: at });
          row = undefined;
        } else Object.assign(row, { status: 'sending', startedAt: at, attempts: row.attempts + 1 });
        return true;
      });
      if (!row) return false;
      lastSentAt = at;
      let result;
      try {
        result = await send({ token: settings.token, chatId: settings.channels[row.target], text: telegramText(row, origin) });
      } catch { result = { status: 'unknown', reason: 'unconfirmed' }; }
      if (closed) return false;
      updateState(data => {
        const current = data.deliveries.find(item => item.id === row.id && item.status === 'sending');
        if (!current) return false;
        const finishedAt = clock();
        if (result.status === 'retry') {
          const due = finishedAt + result.delay;
          data.telegramRetryAt = Math.max(data.telegramRetryAt, due);
          Object.assign(current, current.attempts < 3 ? { status: 'queued', due, reason: 'rate_limited' }
            : { status: 'failed', reason: 'rate_limited', finishedAt });
        } else {
          Object.assign(current, result, { finishedAt });
          if (current.kind === 'test' && result.status === 'accepted') {
            data.verifiedBindings ??= {};
            data.verifiedBindings[current.target] = current.binding;
          }
        }
        return true;
      });
      return true;
    } finally { dispatching = false; }
  }

  function kick() {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void dispatch().then(sent => { if (sent) kick(); }).catch(() => {});
    }, 50);
    timer.unref();
  }

  function acknowledge(id, actor) {
    updateState(data => {
      const incident = data.incidents.find(row => row.id === id);
      if (!incident) throw monitoringError(404, '未找到该告警');
      if (incident.ackAt) return false;
      Object.assign(incident, { ackAt: clock(), ackBy: actor.name });
      return true;
    }, { action: 'monitor_acknowledge', actor, targetId: id });
    return { acknowledged: true };
  }

  function view({ tab = 'incidents', status = '', page = 1, pageSize = 20 } = {}) {
    const { data } = state();
    if (tab === 'deliveries') return pageOf(data.deliveries.filter(row => !status || row.status === status).map(row => ({
      id: row.id, incidentId: row.incidentId, label: row.kind === 'test' ? '渠道测试' : monitorRules[row.code].label,
      kind: row.kind, target: monitorChannels[row.target], status: row.status, attempts: row.attempts,
      at: row.at, finishedAt: row.finishedAt, messageId: row.messageId, reason: row.reason
    })), page, pageSize);
    const checks = Object.entries(monitorRules).filter(([, rule]) => !rule.oneShot).map(([code, rule]) => {
      const readings = [...samples.values()].filter(sample => sample.code === code);
      const observed = readings.sort((a, b) => b.at - a.at)[0];
      const open = data.incidents.some(row => row.code === code && !row.resolvedAt);
      return { label: rule.label, category: rule.category, at: observed?.at ?? null,
        status: !observed || clock() - observed.at > 5 * minute || observed.status === 'unknown' ? 'unknown' :
          open ? 'bad' : observed.status === 'bad' ? 'watch' : observed.status };
    });
    return { checks, ...pageOf(data.incidents.filter(row => !status ||
      (status === 'resolved' ? Boolean(row.resolvedAt) : status === 'acknowledged' ? Boolean(row.ackAt) :
        !row.resolvedAt && !row.ackAt)).map(row => ({
      id: row.id, label: monitorRules[row.code].label, priority: monitorRules[row.code].priority,
      category: monitorRules[row.code].category, kind: monitorRules[row.code].oneShot ? 'event' : 'incident',
      taskTail: taskMonitorRules.has(row.code) ? row.scope.slice(-6) : '',
      taskId: taskMonitorRules.has(row.code) ? row.scope : undefined,
      count: row.count, summary: row.summary, at: row.at, resolvedAt: row.resolvedAt, ackAt: row.ackAt, ackBy: row.ackBy,
      queueFull: row.queueFull, external: row.external,
      accepted: row.externalAccepted || data.deliveries.some(item => item.incidentId === row.id &&
        item.kind === 'opened' && item.status === 'accepted')
    })), page, pageSize) };
  }

  return { observe, receiveProbe, configView, view, save, importLegacy, takeOver, acknowledge, queueTest, dispatch,
    probeAt: () => lastProbeAt,
    activeCount: () => state().data.incidents.filter(row => !row.resolvedAt && !monitorRules[row.code].oneShot).length,
    legacyStatus: () => config().data.legacy,
    // The browser legacy settings are frozen while the handoff is being verified.
    legacyLocked: () => transferring || config().data.legacy.phase !== 'native',
    close() { closed = true; clearTimeout(timer); }
  };
}
