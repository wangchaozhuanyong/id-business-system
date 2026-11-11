import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseToolPublicOrigin } from './tools/request-origin.mjs';
import { signMonitoringReport } from './monitoring-route.mjs';
import { botTokenPattern, chatIdPattern, monitorReportPath, readyPath, sendTelegram, telegramText } from './monitoring-policy.mjs';

const minute = 60_000;
const day = 24 * 60 * minute;

export function checkPublicReadiness(origin) {
  return new Promise(resolve => {
    const unknown = { status: 'bad', certificateDays: null };
    const req = request(origin + readyPath, { method: 'GET', signal: AbortSignal.timeout(8000) }, res => {
      const expires = Date.parse(res.socket.getPeerCertificate()?.valid_to || '');
      const certificateDays = Number.isFinite(expires) ? Math.min(1000, Math.max(0, Math.floor((expires - Date.now()) / day))) : null;
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 64) res.destroy();
      });
      res.on('end', () => resolve({ status: res.statusCode === 200 && body === 'id-business-ready\n' ? 'ok' : 'bad', certificateDays }));
      res.on('close', () => resolve(unknown));
      res.on('error', () => resolve(unknown));
    });
    req.on('error', () => resolve(unknown));
    req.end();
  });
}

export function advanceSiteProbe(previous, sample, at) {
  const prior = previous || { status: 'unknown', streak: 0 };
  const streak = prior.status === sample.status && at - prior.at <= 3 * minute ? prior.streak + 1 : 1;
  const next = { ...prior, at, status: sample.status, streak };
  if (sample.status === 'bad' && streak >= 3 && (!prior.incident || prior.incident.recoveredAt)) {
    if (prior.incident?.recoveredAt) next.backlog = [...(prior.backlog || []), prior.incident];
    next.incident = { at, id: randomUUID(), opened: { status: 'queued', due: at, attempts: 0 } };
  }
  if (sample.status === 'ok' && streak >= 2 && prior.incident && !prior.incident.recoveredAt)
    next.incident = { ...prior.incident, recoveredAt: at, recovered: { status: 'queued', due: at, attempts: 0 } };
  return next;
}

export async function runSiteProbeCycle({ origin, secret, token, chatId, previous, persist, check = checkPublicReadiness,
  send = sendTelegram, fetchImpl = fetch, clock = Date.now }) {
  const sample = await check(origin);
  const at = clock();
  const current = advanceSiteProbe(previous, sample, at);
  await persist(current);
  const backlog = current.backlog?.[0];
  for (const incident of [current.incident, backlog].filter(Boolean)) {
    for (const kind of ['opened', 'recovered']) {
      const item = incident[kind];
      if (!item) continue;
      if (item.status === 'sending') {
        // A crash may have happened after Telegram accepted the request.
        item.status = 'unknown';
        await persist(current);
      }
      if (item.status !== 'queued' || item.due > at) continue;
      if (kind === 'recovered' && incident.opened.status === 'queued') break;
      item.status = 'sending';
      item.attempts++;
      await persist(current);
      let result;
      try {
        result = await send({ token, chatId, text: telegramText({
          code: 'public_site', kind, at: kind === 'opened' ? incident.at : incident.recoveredAt,
          incidentId: incident.id, scope: 'system'
        }, origin) });
      } catch { result = { status: 'unknown' }; }
      if (result.status === 'retry' && item.attempts < 3) {
        item.status = 'queued';
        item.due = clock() + result.delay;
      } else item.status = result.status === 'retry' ? 'failed' : result.status;
      await persist(current);
    }
  }
  const reported = backlog || current.incident;
  const body = JSON.stringify({ at, ...sample, ...(reported && { incident: { id: reported.id, at: reported.at,
    accepted: reported.opened.status === 'accepted', recoveredAt: reported.recoveredAt } }) });
  try {
    const result = await fetchImpl(origin + monitorReportPath, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', 'X-ID-Probe-Signature': signMonitoringReport(secret, body) }, body });
    await result.body?.cancel();
    if (result.status === 204 && reported?.recoveredAt && reported.recovered.status !== 'queued') {
      if (backlog) current.backlog = current.backlog.slice(1);
      else delete current.incident;
      await persist(current);
    }
  } catch { /* The site may be unavailable. Keep the incident for the next report. */ }
  return current;
}

async function stateFile(directory, origin) {
  if (!isAbsolute(directory || '')) throw new Error('探针状态目录须使用绝对路径');
  const root = await lstat(directory);
  if (!root.isDirectory() || root.uid !== process.getuid() || (root.mode & 0o777) !== 0o700 ||
      await realpath(directory) !== directory) throw new Error('探针状态目录必须为服务账号专用目录');
  const file = join(directory, 'site-probe.json');
  let previous;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.uid !== root.uid || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 ||
        stat.size > 512 * 1024) throw new Error('探针状态文件无效');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.origin !== origin || !saved.state) throw new Error('探针状态归属不匹配');
    previous = saved.state;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { previous, async persist(state) {
    const tmp = join(directory, '.site-probe-' + randomUUID());
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ origin, state })); await handle.sync(); } finally { await handle.close(); }
      await rename(tmp, file);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  } };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const { ID_MONITOR_PROBE_ORIGIN, ID_MONITOR_PROBE_SECRET: secret, ID_MONITOR_PROBE_BOT_TOKEN: token,
      ID_MONITOR_PROBE_CHAT_ID: chatId, ID_MONITOR_PROBE_STATE_DIR: directory } = process.env;
    const origin = parseToolPublicOrigin(ID_MONITOR_PROBE_ORIGIN)?.origin;
    if (!origin || typeof secret !== 'string' || Buffer.byteLength(secret) < 32 ||
        !botTokenPattern.test(token) || !chatIdPattern.test(chatId)) throw new Error();
    const { previous, persist } = await stateFile(directory, origin);
    let state = previous;
    const stop = new AbortController();
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop.abort());
    while (!stop.signal.aborted) {
      const started = Date.now();
      state = await runSiteProbeCycle({ origin, secret, token, chatId, previous: state, persist });
      await delay(Math.max(0, minute - (Date.now() - started)), undefined, { signal: stop.signal });
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      process.stderr.write('站外探针启动或写入失败，请核对专用配置与状态目录。\n');
      process.exitCode = 1;
    }
  }
}
