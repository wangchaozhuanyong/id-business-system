import { calendarDate, calendarDates, calendarRange } from '../calendar-range.mjs';
import { parseToolPublicOrigin, toolRequestOrigin } from './request-origin.mjs';
import { storefrontVisitSites } from './website-visits.mjs';

export const websiteStorefrontVisitorsRoute = '/api/local/tools/storefront-visitors';
const upstream = 'https://console.moyaoai.com/api/storefront/visitors';
const maxResponseBytes = 16 * 1024;

function validCount(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

async function readReport(response, query, dates) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Storefront visitors unavailable');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxResponseBytes) throw new Error('Storefront visitors response too large');
    chunks.push(chunk);
  }
  const report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (report?.site !== query.site || report.from !== query.from || report.to !== query.to ||
      report.timeZone !== 'UTC' || !validCount(report.visitors) ||
      typeof report.hasUnidentifiedViews !== 'boolean' || !Array.isArray(report.daily) ||
      report.daily.length !== dates.length ||
      report.daily.some((row, index) => row?.date !== dates[index] || !validCount(row.visitors)))
    throw new Error('Invalid storefront visitors report');

  const knownCounts = report.daily.map(row => row.visitors).filter(count => count !== null);
  if (knownCounts.length) {
    const mostVisitorsInOneDay = Math.max(...knownCounts);
    const sumOfDailyVisitors = knownCounts.reduce((sum, count) => sum + count, 0);
    if (report.visitors === null || report.visitors < mostVisitorsInOneDay || report.visitors > sumOfDailyVisitors)
      throw new Error('Inconsistent storefront visitors count');
  } else if (report.visitors !== null) {
    throw new Error('Inconsistent storefront visitors count');
  }
  return {
    ...query, status: 'ready', timeZone: 'UTC', visitors: report.visitors,
    daily: report.daily.map(({ date, visitors }) => ({ date, visitors })),
    hasUnidentifiedViews: report.hasUnidentifiedViews
  };
}

export function createWebsiteStorefrontVisitors({ config, publicOrigin, fetchImpl = fetch, clock = Date.now } = {}) {
  if (config !== undefined && (!config || typeof config !== 'object' || !Object.hasOwn(config, 'token') ||
      Object.keys(config).length !== 1 || typeof config.token !== 'string' || !/^[a-f0-9]{64}$/.test(config.token)))
    throw new Error('商城访客统计专用凭据格式无效');
  const token = config?.token;
  const publicUrl = parseToolPublicOrigin(publicOrigin);
  return async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'GET') return send(405, { error: '商城访客统计只支持 GET' });
    const origin = toolRequestOrigin(req.headers, publicUrl);
    if (!origin || (req.headers.origin && req.headers.origin !== origin) ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))
      return send(403, { error: '请求来源未通过校验' });

    const params = new URL(req.url, 'http://127.0.0.1').searchParams;
    const site = params.get('site'), from = params.get('from'), to = params.get('to');
    const range = calendarRange(from, to, 0);
    if (params.size !== 3 || !storefrontVisitSites.includes(site) ||
        !range || range.days > 30 || to > calendarDate(clock(), 'UTC'))
      return send(400, { error: '请选择支持的商城及有效日期，统计区间最多 30 天' });
    const query = { site, from, to };
    if (!token) return send(200, { ...query, status: 'unconfigured' });

    try {
      const url = new URL(upstream);
      url.search = new URLSearchParams(query);
      const response = await fetchImpl(url, {
        method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + token }
      });
      return send(200, await readReport(response, query, calendarDates(from, range.days)));
    } catch {
      return send(502, { error: '暂时无法读取商城访客统计，请稍后重试' });
    }
  };
}
