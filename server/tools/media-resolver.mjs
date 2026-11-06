import { randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseToolPublicOrigin, toolRequestOrigin } from './request-origin.mjs';

const platforms = {
  douyin: ['douyin.com'], tiktok: ['tiktok.com'], youtube: ['youtube.com', 'youtu.be'],
  instagram: ['instagram.com'], x: ['x.com', 'twitter.com'], bilibili: ['bilibili.com', 'b23.tv'],
  facebook: ['facebook.com', 'fb.watch'], vimeo: ['vimeo.com'], reddit: ['reddit.com', 'redd.it'],
  soundcloud: ['soundcloud.com'], twitch: ['twitch.tv'], pinterest: ['pinterest.com', 'pin.it'],
  dailymotion: ['dailymotion.com', 'dai.ly'], weibo: ['weibo.com', 'weibo.cn']
};
const basePath = '/api/local/tools/media/';
const maxDownload = 256 * 1024 * 1024;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const extensionPattern = /^[a-z0-9]{1,8}$/;
const formatPattern = /^[A-Za-z0-9:_-]{1,64}$/;
const types = ['video', 'audio', 'image'];

class MediaError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function normalizeMediaInput(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 4096)
    throw new MediaError(400, '请粘贴 1 至 4096 字的作品链接或分享文本');
  const input = value.trim();
  const match = input.match(/https?:\/\/[^\s<>"'`]+/iu)?.[0];
  let url;
  try {
    const candidate = match ?? (/^[^\s/]+\.[^\s]+$/u.test(input) ? 'https://' + input : '');
    url = new URL(candidate.replace(/[),.;!?\]}，。；！？）】》」』]+$/u, ''));
  } catch {
    throw new MediaError(400, '没有找到可解析的作品链接');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port)))
    throw new MediaError(400, '作品链接格式无效');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const platform = Object.keys(platforms).find((key) =>
    platforms[key].some((name) => host === name || host.endsWith('.' + name))
  );
  if (!platform) throw new MediaError(400, '暂不支持该平台，请使用抖音、TikTok、YouTube、Instagram、X、B站等公开作品链接');
  url.hash = '';
  return { engine: platform === 'douyin' ? 'f2' : 'yt-dlp', platform, url: url.href };
}

export function mediaWorkerOrigin(value) {
  if (value === undefined) return null;
  const url = URL.parse(value);
  if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('解析执行器须配置为独立的 127.0.0.1 HTTP 回环端口');
  return url.origin;
}

async function readJson(body, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of body) {
    length += chunk.length;
    if (length > limit) throw new Error('body limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function workerError(status, code) {
  if (status === 429 || code === 'busy') return new MediaError(429, '解析任务较多，请稍后重试');
  const messages = {
    too_large: '文件超过 256 MB，无法下载',
    audio_missing: '此视频没有音轨，可以下载视频',
    unsupported: '该作品类型暂不支持下载',
    login_required: '作品需要平台登录，无法解析公开内容',
    region_restricted: '该作品受地区访问限制',
    private_or_missing: '作品不可公开访问或已删除',
    platform_limited: '来源平台暂时限制解析，请稍后重试',
    ticket_expired: '下载凭证已失效，请重新解析'
  };
  const message = Object.hasOwn(messages, code) ? messages[code] : '处理作品失败，请确认链接可公开访问';
  return new MediaError(code === 'platform_limited' ? 503 : status >= 500 ? 502 : 400, message);
}

function safeText(value, length, fallback = null) {
  return (typeof value === 'string' && value.replace(/[\p{C}]/gu, '').trim().slice(0, length)) || fallback;
}

function numberWithin(value, max) {
  return Number.isFinite(value) && value > 0 && value <= max ? value : null;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  res.end(JSON.stringify(payload));
}

export function createMediaResolver({ url, publicOrigin, fetchWorker = fetch, clock = Date.now } = {}) {
  const publicUrl = parseToolPublicOrigin(publicOrigin);
  const origin = mediaWorkerOrigin(url);
  const tickets = new Map();
  const rate = new Map();
  const active = { resolve: new Set(), download: new Set() };

  async function worker(path, body, signal) {
    let response;
    try {
      response = await fetchWorker(origin + path, {
        method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch {
      throw new MediaError(signal.aborted ? 504 : 503, signal.aborted ? '处理超时，请重试' : '解析执行器暂不可用');
    }
    if (!response.ok || !response.body) {
      const error = response.body && await readJson(response.body, 16_384).catch(() => null);
      throw workerError(response.status, error?.code);
    }
    return response;
  }

  async function resolve(req, res, userId) {
    if (req.method !== 'POST' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
      throw new MediaError(405, '解析请求须使用 JSON POST');
    const input = await readJson(req.iterator({ destroyOnReturn: false }), 20_000).catch(() => null);
    if (!input) {
      req.resume();
      throw new MediaError(400, '解析请求格式无效');
    }
    const normalized = normalizeMediaInput(input.url);
    const now = clock();
    for (const [user, timestamps] of rate)
      if (timestamps.at(-1) <= now - 60_000) rate.delete(user);
    const attempts = (rate.get(userId) || []).filter((time) => time > now - 60_000);
    if (attempts.length >= 10 || (!rate.has(userId) && rate.size >= 5000))
      throw new MediaError(429, '解析请求过多，请稍后重试');
    rate.set(userId, [...attempts, now]);

    const response = await worker('/resolve', normalized, AbortSignal.timeout(35_000));
    const data = await readJson(response.body, 1024 * 1024).catch(() => null);
    if (!Array.isArray(data?.options) || data.options.length < 1 || data.options.length > 100)
      throw new MediaError(502, '解析服务没有返回有效下载选项');
    const title = safeText(data.title, 160, '未命名作品');
    const mediaType = types.includes(data.mediaType) ? data.mediaType : 'video';
    const expiresAt = clock() + 600_000;
    for (const [token, ticket] of tickets) if (ticket.expiresAt <= clock()) tickets.delete(token);
    const userTickets = [...tickets.values()].filter((ticket) => ticket.userId === userId).length;
    if (tickets.size + data.options.length > 1000 || userTickets + data.options.length > 200)
      throw new MediaError(429, '待下载文件过多，请等待旧凭证过期后再解析');
    const accepted = data.options.map((item, index) => {
      if (typeof item?.formatId !== 'string' || !formatPattern.test(item.formatId) ||
          typeof item.extension !== 'string' || !extensionPattern.test(item.extension) ||
          typeof item.workerToken !== 'string' || !tokenPattern.test(item.workerToken))
        throw new MediaError(502, '解析服务返回了无效下载选项');
      const label = safeText(item.label, 60, '下载选项 ' + (index + 1));
      const type = types.includes(item.mediaType) ? item.mediaType :
        item.formatId === 'audio' ? 'audio' : item.formatId.startsWith('image:') ? 'image' : mediaType;
      return {
        item, filename: safeText((title + (index ? ' - ' + label : '')).replace(/[\\/:*?"<>|]/g, '-'), 160, '媒体文件'),
        option: { label, mediaType: type, extension: item.extension,
          estimatedBytes: numberWithin(item.estimatedBytes, maxDownload),
          width: numberWithin(item.width, 16_384), height: numberWithin(item.height, 16_384),
          downloadToken: randomBytes(32).toString('base64url') }
      };
    });
    for (const { item, option, filename } of accepted)
      tickets.set(option.downloadToken, {
        userId, expiresAt, filename, extension: option.extension,
        body: { ...normalized, formatId: item.formatId, workerToken: item.workerToken }
      });
    sendJson(res, 200, {
      title, author: safeText(data.author, 100), mediaType,
      durationSeconds: numberWithin(data.durationSeconds, 86_400),
      platform: normalized.platform, engine: normalized.engine,
      expiresAt: new Date(expiresAt).toISOString(), options: accepted.map(({ option }) => option)
    });
  }

  async function download(req, res, userId, requestUrl) {
    if (req.method !== 'GET') throw new MediaError(405, '下载请求须使用 GET');
    const token = requestUrl.searchParams.get('token');
    const ticket = typeof token === 'string' && tokenPattern.test(token) && tickets.get(token);
    if (!ticket || ticket.userId !== userId || ticket.expiresAt <= clock())
      throw new MediaError(400, '下载凭证无效或已过期，请重新解析');

    const abort = new AbortController();
    const disconnect = () => abort.abort();
    res.once('close', disconnect);
    try {
      const response = await worker('/download', ticket.body,
        AbortSignal.any([abort.signal, AbortSignal.timeout(360_000)]));
      const bytes = Number(response.headers.get('content-length'));
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxDownload) {
        await response.body.cancel();
        throw new MediaError(400, '文件过大或大小未知，单个文件最多 256 MB');
      }
      const workerExtension = response.headers.get('x-media-extension') || '';
      const extension = extensionPattern.test(workerExtension) ? workerExtension : ticket.extension;
      const filename = encodeURIComponent(ticket.filename + '.' + extension).replace(/'/g, '%27');
      let sent = 0;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': bytes,
        'Content-Disposition': `attachment; filename="media.${extension}"; filename*=UTF-8''${filename}`,
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'
      });
      const limiter = new Transform({
        transform(chunk, _encoding, done) {
          sent += chunk.length;
          if (sent > bytes) return done(new Error('unexpected response size'));
          done(null, chunk);
        },
        flush(done) {
          done(sent === bytes ? null : new Error('incomplete download'));
        }
      });
      await pipeline(Readable.fromWeb(response.body), limiter, res);
    } finally {
      res.off('close', disconnect);
      abort.abort();
    }
  }

  return async (req, res, actor) => {
    let pending;
    let reserved = false;
    const userId = actor?.id;
    try {
      if (!userId) throw new MediaError(401, '请先登录');
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      const op = requestUrl.pathname.slice(basePath.length);
      if (!Object.hasOwn(active, op)) throw new MediaError(404, '没有此工具操作');
      const requestOrigin = toolRequestOrigin(req.headers, publicUrl);
      if (!requestOrigin || (req.headers.origin && req.headers.origin !== requestOrigin) ||
          (op === 'resolve' && req.headers.origin !== requestOrigin) ||
          (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))
        throw new MediaError(403, '请求来源未通过校验');
      if (!origin) throw new MediaError(503, '解析执行器尚未配置');
      pending = active[op];
      if (pending.has(userId) || pending.size >= 2) throw new MediaError(429, '解析任务较多，请稍后重试');
      pending.add(userId);
      reserved = true;
      if (op === 'resolve') await resolve(req, res, userId);
      else await download(req, res, userId, requestUrl);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      sendJson(res, error instanceof MediaError ? error.status : 502, {
        error: error instanceof MediaError ? error.message : '解析服务返回内容异常'
      });
    } finally {
      if (reserved) pending.delete(userId);
    }
  };
}
