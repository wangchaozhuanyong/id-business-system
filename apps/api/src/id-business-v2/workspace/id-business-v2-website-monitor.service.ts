import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException
} from '@nestjs/common';
import {
  V2_WEBSITE_MONITOR_LIMITS,
  type V2WebsiteMonitorErrorCategory,
  type V2WebsiteMonitorHop,
  type V2WebsiteMonitorResult,
  type V2WebsiteMonitorTls
} from '@apple-business/shared';
import { lookup } from 'node:dns/promises';
import { request as requestHttp } from 'node:http';
import { request as requestHttps, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { TLSSocket } from 'node:tls';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { CheckIdBusinessV2WebsiteDto } from './dto/id-business-v2-website-monitor.dto';
import {
  isPublicWebsiteAddress,
  normalizeV2WebsiteMonitorInput
} from './id-business-v2-website-monitor-input';

const RATE_WINDOW_MS = 60_000;
const MAX_CHECKS_PER_WINDOW = 20;
const MAX_RATE_LIMIT_USERS = 5_000;
const MAX_ACTIVE_CHECKS = 8;
const DNS_TIMEOUT_MS = 3_000;
const SLOW_RESPONSE_MS = 3_000;
const TLS_WARNING_DAYS = 14;

export interface WebsiteHopProbe {
  durationMs: number;
  location: string | null;
  statusCode: number;
  tls: V2WebsiteMonitorTls | null;
}

export interface WebsiteProbeTrace {
  finalUrl: URL;
  hops: V2WebsiteMonitorHop[];
  responseTimeMs: number;
  statusCode: number;
  tls: V2WebsiteMonitorTls | null;
}

interface ResolvedWebsiteAddress {
  address: string;
  family: 4 | 6;
}

class WebsiteProbeFailure extends Error {
  constructor(
    readonly category: V2WebsiteMonitorErrorCategory,
    readonly finalUrl: URL,
    readonly hops: V2WebsiteMonitorHop[] = []
  ) {
    super(category);
  }
}

@Injectable()
export class IdBusinessV2WebsiteMonitorService {
  private readonly checkWindows = new Map<string, number[]>();
  private readonly activeUsers = new Set<string>();
  private activeChecks = 0;

  async check(
    dto: CheckIdBusinessV2WebsiteDto,
    operator?: AuthenticatedUser
  ): Promise<V2WebsiteMonitorResult> {
    const userId = this.requireUserId(operator);
    const target = normalizeV2WebsiteMonitorInput(dto.url);
    this.reserveCheck(userId);
    this.acquireCheck(userId);

    try {
      const trace = await this.probeTarget(target);
      return this.createResult(trace);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const failure =
        error instanceof WebsiteProbeFailure
          ? error
          : new WebsiteProbeFailure('connection', target);
      return this.createFailureResult(failure);
    } finally {
      this.releaseCheck(userId);
    }
  }

  protected async probeTarget(target: URL): Promise<WebsiteProbeTrace> {
    const hops: V2WebsiteMonitorHop[] = [];
    const visited = new Set<string>();
    let current = target;

    for (let index = 0; index <= V2_WEBSITE_MONITOR_LIMITS.redirects; index += 1) {
      if (visited.has(current.href)) throw new WebsiteProbeFailure('redirect', current, hops);
      visited.add(current.href);

      let probe: WebsiteHopProbe;
      try {
        probe = await this.probeHop(current);
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        const category = classifyProbeError(error);
        throw new WebsiteProbeFailure(category, current, hops);
      }
      hops.push({
        durationMs: probe.durationMs,
        statusCode: probe.statusCode,
        url: publicDisplayUrl(current)
      });

      if (
        (probe.tls && !probe.tls.authorized) ||
        !isRedirectStatus(probe.statusCode) ||
        !probe.location
      ) {
        return {
          finalUrl: current,
          hops,
          responseTimeMs: hops.reduce((total, hop) => total + hop.durationMs, 0),
          statusCode: probe.statusCode,
          tls: probe.tls
        };
      }
      if (index >= V2_WEBSITE_MONITOR_LIMITS.redirects) {
        throw new WebsiteProbeFailure('redirect', current, hops);
      }

      let redirectUrl: URL;
      try {
        redirectUrl = new URL(probe.location, current);
      } catch {
        throw new WebsiteProbeFailure('redirect', current, hops);
      }
      current = normalizeV2WebsiteMonitorInput(redirectUrl.href);
    }

    throw new WebsiteProbeFailure('redirect', current, hops);
  }

  protected async probeHop(target: URL): Promise<WebsiteHopProbe> {
    const startedAt = performance.now();
    const resolved = await resolvePublicAddress(target.hostname);
    const requester = target.protocol === 'https:' ? requestHttps : requestHttp;
    const hostname = normalizedHostname(target.hostname);
    const options: RequestOptions = {
      agent: false,
      family: resolved.family,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.1',
        'Accept-Encoding': 'identity',
        Connection: 'close',
        Host: target.host,
        'User-Agent': 'ID-Business-Website-Monitor/1.0'
      },
      hostname: resolved.address,
      maxHeaderSize: 32 * 1024,
      method: 'GET',
      path: `${target.pathname}${target.search}`,
      port: target.port || undefined,
      protocol: target.protocol,
      rejectUnauthorized: false,
      servername: target.protocol === 'https:' && isIP(hostname) === 0 ? hostname : undefined
    };

    return new Promise<WebsiteHopProbe>((resolve, reject) => {
      let settled = false;
      const request = requester(options, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const tls = readTls(response.socket, target.protocol);
        const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
        const statusCode = response.statusCode ?? 0;
        const location = normalizeLocation(response.headers.location);
        response.destroy();
        resolve({ durationMs, location, statusCode, tls });
      });
      const timeout = setTimeout(() => {
        request.destroy(createNetworkError('ETIMEDOUT'));
      }, V2_WEBSITE_MONITOR_LIMITS.requestTimeoutMs);
      timeout.unref?.();
      request.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      request.end();
    });
  }

  private createResult(trace: WebsiteProbeTrace): V2WebsiteMonitorResult {
    const assessment = assessWebsite(trace);
    return {
      checkedAt: new Date().toISOString(),
      errorCategory: null,
      finalUrl: publicDisplayUrl(trace.finalUrl),
      hops: trace.hops,
      message: assessment.message,
      responseTimeMs: trace.responseTimeMs,
      status: assessment.status,
      statusCode: trace.statusCode,
      tls: trace.tls
    };
  }

  private createFailureResult(failure: WebsiteProbeFailure): V2WebsiteMonitorResult {
    return {
      checkedAt: new Date().toISOString(),
      errorCategory: failure.category,
      finalUrl: publicDisplayUrl(failure.finalUrl),
      hops: failure.hops,
      message: failureMessage(failure.category),
      responseTimeMs: null,
      status: 'down',
      statusCode: null,
      tls: null
    };
  }

  private reserveCheck(userId: string) {
    const now = Date.now();
    const cutoff = now - RATE_WINDOW_MS;
    for (const [key, timestamps] of this.checkWindows) {
      const active = timestamps.filter((timestamp) => timestamp >= cutoff);
      if (active.length) this.checkWindows.set(key, active);
      else this.checkWindows.delete(key);
    }
    const timestamps = (this.checkWindows.get(userId) ?? []).filter(
      (timestamp) => timestamp >= cutoff
    );
    if (timestamps.length >= MAX_CHECKS_PER_WINDOW) {
      throw new HttpException('检测过于频繁，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (!this.checkWindows.has(userId) && this.checkWindows.size >= MAX_RATE_LIMIT_USERS) {
      throw new ServiceUnavailableException('网站检测服务繁忙，请稍后重试');
    }
    timestamps.push(now);
    this.checkWindows.set(userId, timestamps);
  }

  private acquireCheck(userId: string) {
    if (this.activeChecks >= MAX_ACTIVE_CHECKS || this.activeUsers.has(userId)) {
      throw new HttpException('已有网站检测正在进行，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.activeChecks += 1;
    this.activeUsers.add(userId);
  }

  private releaseCheck(userId: string) {
    this.activeChecks = Math.max(0, this.activeChecks - 1);
    this.activeUsers.delete(userId);
  }

  private requireUserId(operator?: AuthenticatedUser) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    return operator.id;
  }
}

async function resolvePublicAddress(hostnameInput: string): Promise<ResolvedWebsiteAddress> {
  const hostname = normalizedHostname(hostnameInput);
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!isPublicWebsiteAddress(hostname)) {
      throw new BadRequestException('网站监控只允许检测公开网站');
    }
    return { address: hostname, family: literalFamily };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(createNetworkError('EDNSTIMEOUT')), DNS_TIMEOUT_MS);
        timeout.unref?.();
      })
    ]);
    if (!addresses.length) throw createNetworkError('ENOTFOUND');
    if (addresses.some((entry) => !isPublicWebsiteAddress(entry.address))) {
      throw new BadRequestException('网站监控只允许检测公开网站');
    }
    const selected = addresses.find((entry) => entry.family === 4) ?? addresses[0];
    if (!selected || (selected.family !== 4 && selected.family !== 6)) {
      throw createNetworkError('ENOTFOUND');
    }
    return { address: selected.address, family: selected.family };
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assessWebsite(trace: WebsiteProbeTrace): {
  message: string;
  status: V2WebsiteMonitorResult['status'];
} {
  if (trace.statusCode >= 500 || trace.statusCode <= 0) {
    return { message: '网站已响应，但服务端返回异常状态', status: 'down' };
  }
  if (trace.tls && !trace.tls.authorized) {
    return { message: 'HTTPS 证书无效或不受信任', status: 'down' };
  }
  if (trace.statusCode >= 400) {
    return { message: '网站已响应，但当前地址返回访问错误', status: 'warning' };
  }
  if (trace.statusCode >= 300) {
    return { message: '网站返回跳转状态，但没有提供有效目标地址', status: 'warning' };
  }
  if (!trace.tls) {
    return { message: '网站可访问，但当前地址未使用 HTTPS', status: 'warning' };
  }
  if (trace.tls.daysRemaining !== null && trace.tls.daysRemaining <= TLS_WARNING_DAYS) {
    return { message: '网站可访问，但 HTTPS 证书即将到期', status: 'warning' };
  }
  if (trace.responseTimeMs >= SLOW_RESPONSE_MS) {
    return { message: '网站可访问，但本次响应较慢', status: 'warning' };
  }
  return { message: '网站访问正常', status: 'healthy' };
}

function readTls(socket: NodeJS.ReadableStream, protocol: string): V2WebsiteMonitorTls | null {
  if (protocol !== 'https:' || !(socket instanceof TLSSocket)) return null;
  const certificate = socket.getPeerCertificate();
  const expiresAtMs = Date.parse(certificate.valid_to ?? '');
  const expiresAt = Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null;
  const daysRemaining = Number.isFinite(expiresAtMs)
    ? Math.ceil((expiresAtMs - Date.now()) / (24 * 60 * 60 * 1000))
    : null;
  return {
    authorized: socket.authorized,
    daysRemaining,
    expiresAt,
    protocol: socket.getProtocol()
  };
}

function normalizeLocation(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' && candidate.length <= V2_WEBSITE_MONITOR_LIMITS.url
    ? candidate
    : null;
}

function isRedirectStatus(statusCode: number) {
  return statusCode >= 300 && statusCode < 400;
}

function publicDisplayUrl(value: URL) {
  return `${value.origin}${value.pathname}`;
}

function normalizedHostname(value: string) {
  return value.replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
}

function createNetworkError(code: string) {
  return Object.assign(new Error(code), { code });
}

function classifyProbeError(error: unknown): V2WebsiteMonitorErrorCategory {
  const code =
    typeof error === 'object' && error && 'code' in error ? String(error.code).toUpperCase() : '';
  if (code === 'EDNSTIMEOUT' || code === 'ENODATA' || code === 'ENOTFOUND') return 'dns';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
  if (code.includes('CERT') || code.includes('TLS') || code === 'EPROTO') return 'tls';
  return 'connection';
}

function failureMessage(category: V2WebsiteMonitorErrorCategory) {
  const messages: Record<V2WebsiteMonitorErrorCategory, string> = {
    connection: '无法连接网站，请确认服务已启动且端口可访问',
    dns: '域名解析失败，请确认域名配置是否正确',
    redirect: '网站跳转次数过多或形成循环',
    timeout: '网站在 10 秒内没有响应',
    tls: '无法建立安全连接，请检查 HTTPS 证书配置'
  };
  return messages[category];
}
