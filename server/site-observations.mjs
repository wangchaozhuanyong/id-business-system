import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';

const hour = 3_600_000;
const minute = 60_000;
const maxFileSize = 2 * 1024 * 1024;
const limits = [100, 200, 350, 500, 750, 1000, 1500, 2000, 3000, 5000, 8000, 12000, 20000, 30000, 60000, 120000];
const activities = new Set(['login', 'customer-search', 'order-list', 'order-save']);
const channels = ['browser', 'server'];
const outcomes = ['ok', 'blocked', 'failed', 'connection'];
const reasons = new Set(['identity', 'access', 'conflict', 'limit', 'timeout', 'other']);
function failureReason(status) {
  if (status === 401) return 'identity';
  if (status === 403) return 'access';
  if (status === 409) return 'conflict';
  if (status === 429) return 'limit';
  if (status === 504) return 'timeout';
  return 'other';
}
const diagnosticPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const softwareVersion = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : null;
export const isDiagnostic = value => typeof value === 'string' && diagnosticPattern.test(value);
const bucketAt = at => Math.floor(at / hour) * hour;
const validPercent = n => Number.isFinite(n) && n >= 0 && n <= 100;
const durationValid = n => Number.isSafeInteger(n) && n >= 0 && n <= limits.at(-1);
const percent = n => Math.round(n);
const groupKey = (channel, activity) => channel + ':' + activity;
const blank = () => ({ total: 0, blocked: 0, failed: 0, limited: 0, histogram: limits.map(() => 0) });
const classify = status => status >= 500 ? 'failed' : status >= 400 ? 'blocked' : 'ok';

export function measuredActivity(route, method, intent) {
  if (['/api/local/auth/login', '/api/local/auth/login/verify'].includes(route) && method === 'POST') return 'login';
  if (['/api/local/customer-query/search', '/api/local/customer-query/detail'].includes(route) && method === 'POST')
    return 'customer-search';
  if (route === '/api/local/commerce' && method === 'GET' && intent === 'order-list') return intent;
  if (['/api/local/commerce', '/api/local/batch'].includes(route) && method === 'PUT' && intent === 'order-save')
    return intent;
  if (route === '/api/local/renewals' && method === 'POST' && intent === 'order-save') return intent;
}

function summary(points) {
  const all = blank();
  for (const item of points) {
    all.total += item.total;
    all.blocked += item.blocked;
    all.failed += item.failed;
    all.limited += item.limited || 0;
    item.histogram.forEach((count, i) => { all.histogram[i] += count; });
  }
  const successes = all.total - all.blocked - all.failed;
  let remaining = Math.ceil(successes * 0.95);
  const p95 = successes >= 20
    ? limits.find((_, i) => (remaining -= all.histogram[i]) <= 0) ?? null
    : null;
  return { total: all.total, successes, blocked: all.blocked, failed: all.failed, limited: all.limited, p95 };
}

function loadRows(data, oldest, now) {
  const groups = {};
  for (const [at, point] of Object.entries(data?.groups || {})) {
    const time = Number(at);
    if (!Number.isSafeInteger(time) || bucketAt(time) !== time || time < oldest || time > now || !point) continue;
    const accepted = {};
    for (const channel of channels) for (const activity of activities) {
      const key = groupKey(channel, activity), row = point[key];
      const count = value => Number.isSafeInteger(value) && value >= 0;
      if (row && [row.total, row.blocked, row.failed, row.limited || 0].every(count) && (row.limited || 0) <= row.blocked &&
          Array.isArray(row.histogram) && row.histogram.length === limits.length && row.histogram.every(count) &&
          row.histogram.reduce((sum, n) => sum + n, row.blocked + row.failed) === row.total) accepted[key] = row;
    }
    groups[time] = accepted;
  }
  const resources = {};
  for (const [at, value] of Object.entries(data?.resources || {})) {
    const time = Number(at);
    if (!Number.isSafeInteger(time) || bucketAt(time) !== time || time < oldest || time > now || !value) continue;
    resources[time] = Object.fromEntries(['cpu', 'memory', 'disk'].flatMap(key => {
      const row = value[key];
      return row && Number.isSafeInteger(row.count) && row.count > 0 &&
        Number.isFinite(row.sum) && row.sum >= 0 && row.sum <= row.count * 100 && validPercent(row.low)
        ? [[key, row]] : [];
    }));
  }
  const diagnostics = Array.isArray(data?.diagnostics) ? data.diagnostics.filter(row =>
    isDiagnostic(row?.id) && Number.isSafeInteger(row.at) && row.at >= oldest && row.at <= now &&
    activities.has(row.activity) && outcomes.includes(row.result) && row.result !== 'ok' &&
    channels.includes(row.channel) && (row.version === null || softwareVersion(row.version))
  ).slice(-800).map(({ id, at, activity, result, channel, version, reason }) => ({
    id, at, activity, result, channel, version, ...(reasons.has(reason) && { reason })
  })) : [];
  return { groups, resources, diagnostics };
}

async function readStored(path, oldest, now) {
  if (!path) return loadRows(null, oldest, now);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (info.uid !== process.getuid() || !info.isFile() || info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600 || info.size > maxFileSize) throw new Error();
    const raw = await handle.readFile();
    if (raw.length !== info.size) throw new Error();
    return loadRows(JSON.parse(raw), oldest, now);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return loadRows(null, oldest, now);
  } finally { await handle?.close(); }
}

export async function createSiteObservations({ path, version, clock = Date.now } = {}) {
  const epoch = randomUUID();
  const revision = softwareVersion(version);
  const first = clock();
  let storageAvailable = Boolean(path), storageWritable = Boolean(path);
  const state = await readStored(path, first - 7 * 24 * hour - hour, first).catch(() => {
    storageAvailable = false;
    storageWritable = false;
    return loadRows(null, first, first);
  });
  const listeners = new Set(), recentRequests = new Map(), connectionSamples = new Map();
  let pendingVersion = 0, observedVersion = 0, write, diskDirty = false, storageRetryAt = 0;
  let latest = null, acceptedInMinute = 0, sampleMinute, priorCpu;
  let resourceVersion = 0, backupVersion = epoch;
  const resourceVersionOf = () => epoch + ':' + resourceVersion;
  const backupVersionOf = () => backupVersion;
  const versionOf = () => epoch + ':' + observedVersion;
  const subscribe = callback => { listeners.add(callback); return () => listeners.delete(callback); };

  function note({ at, id, activity, channel, result, elapsed, reason }) {
    const point = state.groups[bucketAt(at)] ??= {};
    const group = point[groupKey(channel, activity)] ??= blank();
    group.total++;
    if (result === 'blocked') {
      group.blocked++;
      if (reason === 'limit') group.limited = (group.limited || 0) + 1;
    }
    else if (result !== 'ok') group.failed++;
    else group.histogram[limits.findIndex(ceiling => elapsed <= ceiling)]++;
    if (id && result !== 'ok') {
      state.diagnostics.push({ id, at, activity, result, channel, version: revision,
        ...(reason && reason !== 'other' && { reason }) });
      if (state.diagnostics.length > 800) state.diagnostics.shift();
    }
    pendingVersion++;
    diskDirty = true;
  }

  function request(response, activity, actorId) {
    if (!activity) return;
    const id = randomUUID(), start = performance.now();
    response.setHeader('X-ID-Diagnostic', id);
    const finished = () => {
      response.removeListener('close', aborted);
      if (activity === 'login' && response.statusCode === 202) return;
      const at = clock(), result = classify(response.statusCode);
      recentRequests.set(id, { activity, at, result, reason: failureReason(response.statusCode), used: false, actorId });
      if (recentRequests.size > 1000) recentRequests.delete(recentRequests.keys().next().value);
      note({ at, id, activity, channel: 'server', result, reason: failureReason(response.statusCode),
        elapsed: Math.min(limits.at(-1), Math.round(performance.now() - start)) });
    };
    const aborted = () => {
      response.removeListener('finish', finished);
      note({ at: clock(), id, activity, channel: 'server', result: 'connection', elapsed: 0 });
    };
    response.once('finish', finished);
    response.once('close', aborted);
  }

  function sample(body, actorId) {
    if (!body || Array.isArray(body) || Object.keys(body).some(key => !['id', 'activity', 'result', 'elapsed'].includes(key)) ||
        !isDiagnostic(body.id) || !activities.has(body.activity) || !outcomes.includes(body.result) ||
        !durationValid(body.elapsed)) return false;
    const at = clock();
    const frame = Math.floor(at / minute);
    if (frame !== sampleMinute) { sampleMinute = frame; acceptedInMinute = 0; }
    if (acceptedInMinute >= 300) return false;
    const linked = recentRequests.get(body.id);
    if (linked && (linked.used || at - linked.at > 5 * minute || linked.activity !== body.activity)) return false;
    if (linked) {
      if (linked.result !== body.result || (body.activity !== 'login' && (!actorId || linked.actorId !== actorId)))
        return false;
    } else {
      if (!actorId || body.activity === 'login' || body.result !== 'connection') return false;
      const used = connectionSamples.get(actorId);
      if (used?.frame === frame && used.count >= 3) return false;
      for (const [id, quota] of connectionSamples) if (quota.frame !== frame) connectionSamples.delete(id);
      connectionSamples.set(actorId, { frame, count: used?.frame === frame ? used.count + 1 : 1 });
    }
    if (linked) linked.used = true;
    else {
      recentRequests.set(body.id, { at, activity: body.activity, used: true });
      if (recentRequests.size > 1000) recentRequests.delete(recentRequests.keys().next().value);
    }
    acceptedInMinute++;
    note({ ...body, at, channel: 'browser', reason: linked?.reason });
    return true;
  }

  function publish() {
    if (pendingVersion === observedVersion) return;
    observedVersion = pendingVersion;
    for (const listener of listeners) {
      try { listener(); } catch { /* Collection must stay independent of website actions. */ }
    }
  }

  async function persist() {
    if (write || !storageWritable || !diskDirty || clock() < storageRetryAt) return write;
    const temporary = path + '.' + randomUUID();
    const raw = JSON.stringify(state);
    if (Buffer.byteLength(raw) > maxFileSize) { storageAvailable = false; return; }
    diskDirty = false;
    write = (async () => {
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(raw); } finally { await handle.close(); }
        await rename(temporary, path);
        storageAvailable = true;
      } catch {
        await unlink(temporary).catch(() => {});
        storageAvailable = false;
        storageRetryAt = clock() + 5 * minute;
        diskDirty = true;
      }
    })().finally(() => { write = undefined; });
    return write;
  }

  async function collect(diskAvailable, backupEvidence) {
    const at = clock(), oldest = bucketAt(at) - 167 * hour;
    for (const collection of [state.groups, state.resources]) for (const key of Object.keys(collection))
      if (Number(key) < oldest) { delete collection[key]; pendingVersion++; diskDirty = true; }
    state.diagnostics = state.diagnostics.filter(row => row.at >= oldest);
    for (const [id, row] of recentRequests) if (at - row.at > 5 * minute) recentRequests.delete(id);
    const rawCpu = cpus().reduce(({ total, idle }, cpu) => ({
      total: total + Object.values(cpu.times).reduce((sum, n) => sum + n, 0), idle: idle + cpu.times.idle
    }), { total: 0, idle: 0 });
    const cpu = priorCpu && rawCpu.total > priorCpu.total
      ? 100 * (1 - (rawCpu.idle - priorCpu.idle) / (rawCpu.total - priorCpu.total)) : null;
    priorCpu = rawCpu;
    let memory = null;
    if (process.platform === 'linux') {
      const file = await readFile('/proc/meminfo', 'utf8').catch(() => '');
      const total = Number(/^MemTotal:\s+(\d+)/m.exec(file)?.[1]);
      const available = Number(/^MemAvailable:\s+(\d+)/m.exec(file)?.[1]);
      if (total > 0) memory = 100 * (1 - available / total);
    } else if (totalmem() > 0) memory = 100 * (1 - freemem() / totalmem());
    const values = { cpu, memory, disk: diskAvailable };
    latest = { at };
    const point = state.resources[bucketAt(at)] ??= {};
    for (const [key, raw] of Object.entries(values)) {
      const value = validPercent(raw) ? percent(raw) : null;
      latest[key] = value;
      if (value === null) continue;
      const row = point[key] ??= { count: 0, sum: 0, low: value };
      row.count++;
      row.sum += value;
      row.low = Math.min(row.low, value);
    }
    resourceVersion++;
    diskDirty = true;
    if (backupEvidence) backupVersion = createHash('sha256').update(JSON.stringify(backupEvidence)).digest('hex');
    if (pendingVersion !== observedVersion) publish();
    else for (const listener of listeners) {
      try { listener(); } catch { /* A disconnected browser cannot stop collection. */ }
    }
    return persist();
  }

  function performanceView(hours) {
    const at = clock(), last = bucketAt(at), count = hours === 168 ? 7 : 24, step = hours / count;
    const buckets = Array.from({ length: hours }, (_, i) => last - (hours - i - 1) * hour);
    const groups = Object.fromEntries(channels.map(channel => {
      const all = points => points.flatMap(time => [...activities].map(activity =>
        state.groups[time]?.[groupKey(channel, activity)]).filter(Boolean));
      return [channel, {
        ...summary(all(buckets)),
        activities: [...activities].map(activity => ({
          activity, ...summary(buckets.map(time => state.groups[time]?.[groupKey(channel, activity)]).filter(Boolean))
        })).sort((a, b) => (b.p95 ?? -1) - (a.p95 ?? -1) || b.total - a.total),
        trend: Array.from({ length: count }, (_, i) => ({
          at: buckets[i * step], ...summary(all(buckets.slice(i * step, (i + 1) * step)))
        }))
      }];
    }));
    return { at, hours, storageAvailable, groups };
  }

  function resourceView() {
    const last = bucketAt(clock());
    return { latest, trend: Array.from({ length: 24 }, (_, index) => {
      const at = last - (23 - index) * hour;
      const point = state.resources[at];
      const mean = key => point?.[key] ? percent(point[key].sum / point[key].count) : null;
      return { at, cpu: mean('cpu'), memory: mean('memory'), disk: point?.disk?.low ?? null };
    }) };
  }

  return { request, sample, collect, performanceView, resourceView, versionOf, resourceVersionOf, backupVersionOf, subscribe,
    diagnostic: id => state.diagnostics.findLast(row => row.id === id && row.channel === 'server') ??
      state.diagnostics.findLast(row => row.id === id) ?? null };
}
