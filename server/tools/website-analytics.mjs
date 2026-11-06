import { createPrivateKey, sign } from 'node:crypto';

const METRICS = ['screenPageViews', 'totalUsers', 'sessions'];

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
    new Date(today - (days - index - 1) * 86_400_000).toISOString().slice(0, 10)
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

export function createWebsiteAnalytics({ config, fetchImpl = fetch, clock = Date.now } = {}) {
  let token;
  let tokenRequest;
  const cache = new Map();
  const pending = new Map();
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
  async function load(days) {
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
      const result = parseWebsiteAnalyticsReport(reports, days, new Date(clock()));
      cache.set(days, { result, expires: clock() + 60_000 });
      return result;
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
    if ((req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))
      return send(403, { error: '请求来源未通过校验' });
    const days = new URL(req.url, 'http://127.0.0.1').searchParams.get('days');
    if (!['7', '30'].includes(days)) return send(400, { error: '请选择最近 7 天或 30 天' });
    if (!configured) return send(503, { error: '尚未配置独立新版的网站访问统计来源' });
    const count = Number(days);
    try {
      const cached = cache.get(count);
      if (cached?.expires > clock()) return send(200, cached.result);
      if (!pending.has(count))
        pending.set(count, load(count).finally(() => pending.delete(count)));
      send(200, await pending.get(count));
    } catch {
      send(502, { error: '无法读取网站访问统计，请核对专用只读授权后重试' });
    }
  };
}
