import { createPrivateKey, sign } from 'node:crypto';

const METRICS = ['screenPageViews', 'totalUsers', 'sessions'];
const renovationSite = 'flashcast.com.my';
const storefronts = new Set(['damatong.net', 'moyaoai.com', 'shop.flashcast.com.my']);
const cloudflareId = /^[a-f\d]{32}$/i;
const dayMs = 86_400_000;

function metrics(row) {
  const values = row.metricValues;
  if (!Array.isArray(values) || values.length !== 3) throw new Error('Invalid metrics');
  const counts = values.map(({ value }) => {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Invalid count');
    const count = Number(value);
    if (!Number.isSafeInteger(count)) throw new Error('Invalid count');
    return count;
  });
  return { pageViews: counts[0], visitors: counts[1], sessions: counts[2] };
}

export function parseWebsiteAnalyticsReport(reports, days, now) {
  if (!Array.isArray(reports) || reports.length !== 2) throw new Error('Missing reports');
  const [summaryReport, dailyReport] = reports;
  const timeZone = summaryReport.metadata?.timeZone;
  if (!timeZone || dailyReport.metadata?.timeZone !== timeZone) throw new Error('Invalid timezone');
  for (const report of reports) {
    // GA4 omits headers as well as rows for a dimensionless report with no matching data.
    const emptySummary =
      report === summaryReport &&
      !report.metricHeaders?.length &&
      !report.rows?.length &&
      (report.rowCount ?? 0) === 0;
    if (
      (!emptySummary &&
        report.metricHeaders?.map(({ name }) => name).join(',') !== METRICS.join(',')) ||
      report.metadata?.dataLossFromOtherRow ||
      (report.rowCount ?? 0) !== (report.rows?.length ?? 0)
    )
      throw new Error('Incomplete report');
  }
  if (
    (summaryReport.rows?.length ?? 0) > 1 ||
    (summaryReport.dimensionHeaders?.length ?? 0) !== 0 ||
    dailyReport.dimensionHeaders?.map(({ name }) => name).join(',') !== 'date'
  ) {
    throw new Error('Invalid report dimensions');
  }
  // GA4 groups dates in the property's timezone. Do not silently relabel them as local dates.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZoneName: 'longOffset'
  }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  const today = Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day')));
  const dates = Array.from({ length: days }, (_, index) =>
    new Date(today - (days - index - 1) * dayMs).toISOString().slice(0, 10)
  );
  const byDate = new Map();
  for (const row of dailyReport.rows ?? []) {
    const raw = row.dimensionValues?.[0]?.value;
    if (typeof raw !== 'string' || !/^\d{8}$/.test(raw) || row.dimensionValues?.length !== 1) {
      throw new Error('Invalid report date');
    }
    const date = raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8);
    if (!dates.includes(date) || byDate.has(date)) throw new Error('Unexpected report date');
    byDate.set(date, metrics(row));
  }
  const summary = summaryReport.rows?.[0] ? metrics(summaryReport.rows[0]) : null;
  if (byDate.size && !summary) throw new Error('Missing summary');
  if (!byDate.size && summary && Object.values(summary).some((value) => value > 0)) {
    throw new Error('Missing daily report');
  }
  return {
    status: byDate.size ? 'ready' : 'empty',
    days,
    fetchedAt: now.toISOString(),
    timeZone,
    utcOffset: part('timeZoneName'),
    thresholded: reports.some((report) => report.metadata?.subjectToThresholding === true),
    summary: byDate.size ? summary : null,
    daily: dates.map((date) => ({ date, metrics: byDate.get(date) ?? null }))
  };
}

const tokenUrl = 'https://oauth2.googleapis.com/token';
const readonlyScope = 'https://www.googleapis.com/auth/analytics.readonly';

async function responseJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok || !response.body) throw Object.assign(new Error('analytics unavailable'), { status: response.status });
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > 256 * 1024) throw new Error('analytics response limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const cloudflareQuery = `query WebsiteTraffic($accountTag: string, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      total: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 1) {
        count
        sum { visits }
      }
      daily: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 31) {
        dimensions { date }
        count
        sum { visits }
      }
    }
  }
}`;

function cloudflareSiteTags(config) {
  if (config === undefined) return new Map();
  if (typeof config?.accountId !== 'string' || !cloudflareId.test(config.accountId) ||
      typeof config.apiToken !== 'string' || !/^[\x21-\x7e]{20,512}$/.test(config.apiToken) ||
      !config.sites || typeof config.sites !== 'object' || Array.isArray(config.sites))
    throw new Error('商城访问统计的 Cloudflare 配置无效');
  const sites = Object.entries(config.sites);
  if (!sites.length || sites.some(([host, tag]) =>
    !storefronts.has(host) || typeof tag !== 'string' || !cloudflareId.test(tag)))
    throw new Error('商城访问统计的域名或 Cloudflare 站点标识无效');
  return new Map(sites);
}

function cloudflareMetrics(row) {
  const pageViews = row?.count;
  const visits = row?.sum?.visits;
  if (![pageViews, visits].every(value => Number.isSafeInteger(value) && value >= 0))
    throw new Error('Invalid Cloudflare metrics');
  return { pageViews, visits };
}

async function loadCloudflareReport(config, site, siteTag, days, now, fetchImpl) {
  const fetchedAt = now.toISOString();
  const midnight = Date.parse(fetchedAt.slice(0, 10) + 'T00:00:00Z');
  const dates = Array.from({ length: days }, (_, index) =>
    new Date(midnight - (days - index - 1) * dayMs).toISOString().slice(0, 10)
  );
  const filter = { AND: [
    { datetime_geq: dates[0] + 'T00:00:00Z', datetime_leq: fetchedAt.slice(0, 19) + 'Z' },
    { bot: 0 },
    { requestHost: site },
    { siteTag_in: [siteTag] }
  ] };
  const payload = await responseJson(fetchImpl, 'https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + config.apiToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: cloudflareQuery, variables: { accountTag: config.accountId, filter } })
  });
  const accounts = payload.data?.viewer?.accounts;
  if (payload.errors?.length || !Array.isArray(accounts) || accounts.length !== 1)
    throw new Error('Cloudflare report unavailable');
  const { total, daily } = accounts[0];
  if (!Array.isArray(total) || total.length > 1 || !Array.isArray(daily) || daily.length > days)
    throw new Error('Incomplete Cloudflare report');
  const byDate = new Map();
  for (const row of daily) {
    const date = row?.dimensions?.date;
    if (!dates.includes(date) || byDate.has(date)) throw new Error('Unexpected Cloudflare report date');
    byDate.set(date, cloudflareMetrics(row));
  }
  const summary = total.length ? cloudflareMetrics(total[0]) : null;
  if ((byDate.size && !summary) || (!byDate.size && (summary?.pageViews || summary?.visits)))
    throw new Error('Incomplete Cloudflare report');
  const reportUrl = new URL(`https://dash.cloudflare.com/${config.accountId}/web-analytics/overview/page-views`);
  reportUrl.searchParams.set('siteTag~in', siteTag);
  reportUrl.searchParams.set('host', site);
  reportUrl.searchParams.set('excludeBots', 'Yes');
  return {
    status: byDate.size ? 'ready' : 'empty',
    days, fetchedAt, timeZone: 'UTC', utcOffset: 'GMT+00:00', reportUrl: reportUrl.href,
    summary: byDate.size ? summary : null,
    daily: dates.map(date => ({ date, metrics: byDate.get(date) ?? null }))
  };
}

export function createWebsiteAnalytics({ config, cloudflareConfig, publicOrigin, fetchImpl = fetch, clock = Date.now } = {}) {
  let token;
  let tokenRequest;
  const cache = new Map();
  const pending = new Map();
  const siteTags = cloudflareSiteTags(cloudflareConfig);
  const propertyId = config?.propertyId;
  const streamId = config?.streamId;
  const hosts = config?.hosts;
  const configured = Boolean(config);
  let privateKey;
  if (configured) {
    const credential = config.serviceAccount;
    if (!/^\d{1,24}$/.test(propertyId || '') || !/^\d{1,24}$/.test(streamId || '') ||
        !Array.isArray(hosts) || !hosts.length || hosts.length > 10 ||
        hosts.some((host) => typeof host !== 'string' || !/^[a-z\d.-]+\.[a-z]{2,}$/i.test(host)) ||
        credential?.type !== 'service_account' || typeof credential.client_email !== 'string' ||
        !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(credential.client_email))
      throw new Error('网站访问统计配置无效');
    try {
      privateKey = createPrivateKey(credential.private_key);
      if (privateKey.asymmetricKeyType !== 'rsa') throw new Error();
    } catch {
      throw new Error('网站访问统计专用密钥格式无效');
    }
  }

  async function requestToken() {
    const now = Math.floor(clock() / 1000);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const data = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({
      iss: config.serviceAccount.client_email, scope: readonlyScope, aud: tokenUrl, iat: now, exp: now + 3600
    });
    const assertion = data + '.' + sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url');
    const result = await responseJson(fetchImpl, tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
    });
    if (typeof result.access_token !== 'string' || !result.access_token ||
        !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Error('invalid oauth token');
    token = { value: result.access_token, expires: clock() + Math.min(result.expires_in, 3600) * 1000 };
    return token.value;
  }
  async function accessToken() {
    if (token?.expires > clock() + 60_000) return token.value;
    tokenRequest ??= requestToken().finally(() => { tokenRequest = undefined; });
    return tokenRequest;
  }
  async function loadGa4(days) {
    const access = await accessToken();
    const filters = {
      andGroup: {
        expressions: [
          { filter: { fieldName: 'hostName', inListFilter: { values: hosts, caseSensitive: false } } },
          { filter: { fieldName: 'streamId', stringFilter: { matchType: 'EXACT', value: streamId } } }
        ]
      }
    };
    try {
      const { reports } = await responseJson(fetchImpl,
        `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:batchRunReports`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [false, true].map((daily) => ({
            dateRanges: [{ startDate: (days - 1) + 'daysAgo', endDate: 'today' }],
            dimensions: daily ? [{ name: 'date' }] : [],
            metrics: METRICS.map((name) => ({ name })),
            dimensionFilter: filters,
            ...(daily ? { orderBys: [{ dimension: { dimensionName: 'date' } }] } : {}),
            limit: '31'
          })) })
        });
      return parseWebsiteAnalyticsReport(reports, days, new Date(clock()));
    } catch (error) {
      if (error.status === 401) token = undefined;
      throw error;
    }
  }

  return async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'GET') return send(405, { error: '访问统计只支持 GET' });
    const origin = publicOrigin || 'http://' + req.headers.host;
    if ((req.headers.origin && req.headers.origin !== origin) ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))
      return send(403, { error: '请求来源未通过校验' });
    const params = new URL(req.url, 'http://127.0.0.1').searchParams;
    const days = params.get('days');
    if (!['7', '30'].includes(days)) return send(400, { error: '请选择最近 7 天或 30 天' });
    const site = params.get('site') ?? renovationSite;
    const isRenovation = site === renovationSite;
    if (!isRenovation && !storefronts.has(site)) return send(400, { error: '请选择支持的统计站点' });
    const siteTag = siteTags.get(site);
    const provider = isRenovation ? 'ga4' : 'cloudflare';
    const count = Number(days);
    if (!(isRenovation ? configured : siteTag)) {
      if (!params.has('site')) return send(503, { error: '尚未配置独立新版的网站访问统计来源' });
      return send(200, { status: 'unconfigured', site, provider, days: count, summary: null, daily: [] });
    }
    const cacheKey = site + ':' + days;
    try {
      const cached = cache.get(cacheKey);
      if (cached?.expires > clock()) return send(200, cached.result);
      if (!pending.has(cacheKey)) {
        const request = isRenovation ? loadGa4(count)
          : loadCloudflareReport(cloudflareConfig, site, siteTag, count, new Date(clock()), fetchImpl);
        pending.set(cacheKey, request.then(report => {
          const result = { ...report, site, provider };
          cache.set(cacheKey, { result, expires: clock() + 60_000 });
          return result;
        }).finally(() => pending.delete(cacheKey)));
      }
      send(200, await pending.get(cacheKey));
    } catch {
      send(502, { error: isRenovation ? '无法读取网站访问统计，请核对专用只读授权后重试'
        : '无法读取 Cloudflare 商城统计，请核对只读授权后重试' });
    }
  };
}
