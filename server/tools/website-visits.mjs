import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { parseToolPublicOrigin, toolRequestOrigin } from './request-origin.mjs';

export const websiteVisitsDomain = 'website-visits';
export class WebsiteVisitError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOSTS = new Set(['flashcast.com.my', 'www.flashcast.com.my']);
export const WEBSITE_VISIT_DAY_MS = 86_400_000;
export const WEBSITE_VISIT_OFFSET_MS = 8 * 3_600_000;

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WebsiteVisitError('访问记录参数无效');
  return value;
}

export function websiteVisitId(value) {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new WebsiteVisitError('访问记录编号无效');
  return value.toLowerCase();
}

export function normalizeWebsiteVisitIp(value) {
  if (typeof value !== 'string' || value.length > 45 || !isIP(value))
    throw new WebsiteVisitError('请输入有效的 IP 地址');
  if (isIP(value) === 4) return value;
  let normalized;
  try {
    normalized = new URL('http://[' + value + ']/').hostname.slice(1, -1);
  } catch {
    throw new WebsiteVisitError('请输入有效的 IP 地址');
  }
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(normalized);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return normalized;
}

export function maskWebsiteVisitIp(ip) {
  return isIP(ip) === 4
    ? ip.split('.').slice(0, 2).join('.') + '.*.*'
    : ip.split(':').filter(Boolean).slice(0, 2).join(':') + ':****';
}

export function parseWebsiteVisitEvent(value) {
  const input = object(value);
  const keys = ['eventId', 'host', 'path', 'ip', 'occurredAt'];
  if (
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((k) => !keys.includes(k))
  )
    throw new WebsiteVisitError('访问记录字段无效');
  if (typeof input.host !== 'string' || !HOSTS.has(input.host))
    throw new WebsiteVisitError('访问记录网站无效');
  if (
    typeof input.path !== 'string' ||
    input.path.length > 1024 ||
    !/^\/(en|zh)(?:\/[A-Za-z0-9_%-]+)*\/?$/.test(input.path) ||
    /%(?![a-f0-9]{2})/i.test(input.path)
  )
    throw new WebsiteVisitError('访问页面路径无效');
  if (
    typeof input.occurredAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.occurredAt) ||
    !Number.isFinite(Date.parse(input.occurredAt)) ||
    new Date(input.occurredAt).toISOString() !== input.occurredAt
  )
    throw new WebsiteVisitError('访问时间无效');
  // Validate the original IP before signing; canonicalize only for persistence and search.
  normalizeWebsiteVisitIp(input.ip);
  websiteVisitId(input.eventId);
  return input;
}

export function websiteVisitSignaturePayload(event) {
  return JSON.stringify([event.eventId, event.host, event.path, event.ip, event.occurredAt]);
}

export function parseWebsiteVisitSearch(value) {
  const input = object(value);
  if (
    Object.keys(input).some((k) => !['days', 'page', 'pageSize', 'sort', 'ip'].includes(k)) ||
    ![7, 30].includes(input.days) ||
    ![10, 20, 50].includes(input.pageSize) ||
    !['newest', 'oldest'].includes(input.sort) ||
    !Number.isInteger(input.page) ||
    Number(input.page) < 1 ||
    Number(input.page) > 1_000_000
  )
    throw new WebsiteVisitError('访问记录查询参数无效');
  const ip =
    input.ip === undefined || input.ip === '' ? undefined : normalizeWebsiteVisitIp(input.ip);
  return { ...input, ip };
}

export function websiteVisitRange(days, now) {
  const today = new Date(now.getTime() + WEBSITE_VISIT_OFFSET_MS).toISOString().slice(0, 10);
  const start = new Date(Date.parse(today + 'T00:00:00+08:00') - (days - 1) * WEBSITE_VISIT_DAY_MS);
  const dates = Array.from({ length: days }, (_, i) =>
    new Date(start.getTime() + WEBSITE_VISIT_OFFSET_MS + i * WEBSITE_VISIT_DAY_MS)
      .toISOString()
      .slice(0, 10)
  );
  return { start, end: now, dates };
}

function retained(rows, now) {
  const earliest = websiteVisitRange(30, new Date(now)).start.getTime();
  return rows.filter((row) => Date.parse(row.occurredAt) >= earliest);
}

export function appendWebsiteVisit(rows, event, now) {
  const entries = retained(rows, now);
  const id = websiteVisitId(event.eventId);
  if (entries.some((row) => row.id === id)) return null;
  if (entries.length >= 20_000)
    throw new WebsiteVisitError('独立版访问明细容量已满，需核对采集量', 503);
  return [...entries, {
    id, host: event.host, path: event.path,
    ip: normalizeWebsiteVisitIp(event.ip), occurredAt: event.occurredAt, receivedAt: new Date(now).toISOString()
  }];
}

export function reportWebsiteVisits(rows, body, now) {
  const query = parseWebsiteVisitSearch(body);
  const { start, dates } = websiteVisitRange(query.days, new Date(now));
  const matches = rows.filter((row) => Date.parse(row.occurredAt) >= start.getTime() &&
    Date.parse(row.occurredAt) <= now && (!query.ip || row.ip === query.ip));
  matches.sort((a, b) => (query.sort === 'oldest' ? 1 : -1) *
    (a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id)));
  const page = Math.min(query.page, Math.max(1, Math.ceil(matches.length / query.pageSize)));
  const daily = new Map();
  let lastReceivedAt = null;
  for (const row of matches) {
    if (row.receivedAt && (!lastReceivedAt || row.receivedAt > lastReceivedAt)) lastReceivedAt = row.receivedAt;
    const date = new Date(Date.parse(row.occurredAt) + WEBSITE_VISIT_OFFSET_MS).toISOString().slice(0, 10);
    const counts = daily.get(date) || { pageViews: 0, visitors: new Set() };
    counts.pageViews++;
    counts.visitors.add(row.ip);
    daily.set(date, counts);
  }
  return {
    status: matches.length ? 'ready' : 'empty', days: query.days, page, pageSize: query.pageSize,
    fetchedAt: new Date(now).toISOString(), lastReceivedAt, total: matches.length,
    summary: matches.length ? { pageViews: matches.length, visitors: new Set(matches.map(({ ip }) => ip)).size } : null,
    daily: dates.map((date) => {
      const item = daily.get(date);
      return { date, metrics: item ? { pageViews: item.pageViews, visitors: item.visitors.size } : null };
    }),
    items: matches.slice((page - 1) * query.pageSize, page * query.pageSize)
      .map(({ id, path, occurredAt, ip }) => ({ id, path, occurredAt, ipMasked: maskWebsiteVisitIp(ip) }))
  };
}

export function getWebsiteVisitIp(rows, id, now) {
  const result = retained(rows, now).find((row) => row.id === websiteVisitId(id));
  if (!result) throw new WebsiteVisitError('访问记录已过期或不存在', 404);
  return { ip: result.ip };
}

export function createWebsiteVisits({ store, secret, publicOrigin, clock = Date.now }) {
  const publicUrl = parseToolPublicOrigin(publicOrigin);
  if (secret !== undefined && (typeof secret !== 'string' || Buffer.byteLength(secret) < 32))
    throw new Error('网站访问采集密钥须至少 32 字节');
  return async (req, res, operation, actor) => {
    const send = (status, result) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end(JSON.stringify(result));
    };
    try {
      if (!secret) throw new WebsiteVisitError('独立版访问采集尚未配置', 503);
      if (req.method !== 'POST') throw new WebsiteVisitError('访问明细只支持 POST', 405);
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
        throw new WebsiteVisitError('请提交 JSON 请求', 415);
      const origin = toolRequestOrigin(req.headers, publicUrl);
      if (!origin || (operation !== 'ingest' && (req.headers.origin !== origin ||
          (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))))
        throw new WebsiteVisitError('请求来源未通过校验', 403);
      const parts = [];
      let bytes = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.byteLength;
        if (bytes > 4096) {
          req.resume();
          throw new WebsiteVisitError('访问记录请求过长', 413);
        }
        parts.push(chunk);
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch {
        throw new WebsiteVisitError('访问记录参数无效');
      }
      if (operation === 'ingest') {
        const signature = req.headers['x-website-visit-signature'];
        if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature))
          throw new WebsiteVisitError('访问采集签名无效', 401);
        const event = parseWebsiteVisitEvent(input);
        if (Math.abs(clock() - Date.parse(event.occurredAt)) > 60_000)
          throw new WebsiteVisitError('访问采集签名已过期', 401);
        const expected = createHmac('sha256', secret).update(websiteVisitSignaturePayload(event)).digest();
        if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
          throw new WebsiteVisitError('访问采集签名无效', 401);
        store.appendWebsiteVisit(event, clock());
        return send(200, { accepted: true });
      }
      if (operation === 'search') return send(200, store.searchWebsiteVisits(input, clock()));
      if (operation === 'reveal') return send(200, store.revealWebsiteVisit(input?.id, clock(), actor));
      return send(404, { error: '没有此访问记录操作' });
    } catch (error) {
      if (res.destroyed) return;
      send(error instanceof WebsiteVisitError ? error.status : 503, {
        error: error instanceof WebsiteVisitError ? error.message : '暂时无法处理访问记录'
      });
    }
  };
}
