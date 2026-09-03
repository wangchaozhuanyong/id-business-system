import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import {
  V2_MEDIA_RESOLVER_LIMITS,
  type V2MediaResolveResult,
  type V2MediaType
} from '@apple-business/shared';
import { randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { ResolveIdBusinessV2MediaDto } from './dto/id-business-v2-media-resolver.dto';
import {
  normalizeV2MediaInput,
  type NormalizedV2MediaInput,
  type V2MediaResolverEngine
} from './id-business-v2-media-input';

const RESOLVE_TIMEOUT_MS = 35_000;
const DOWNLOAD_TIMEOUT_MS = 6 * 60 * 1000;
const TICKET_TTL_MS = V2_MEDIA_RESOLVER_LIMITS.ticketMinutes * 60 * 1000;
const RATE_WINDOW_MS = 60_000;
const MAX_RESOLVES_PER_WINDOW = 10;
const MAX_RATE_LIMIT_USERS = 5_000;
const MAX_TICKETS = 1_000;
const MAX_TICKETS_PER_USER = 20;
const MAX_ACTIVE_RESOLVES = 2;
const MAX_ACTIVE_DOWNLOADS = 2;
const WORKER_RESPONSE_LIMIT = 1024 * 1024;
const DOWNLOAD_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const WORKER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const FORMAT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,64}$/u;
const EXTENSION_PATTERN = /^[a-z0-9]{1,8}$/u;

interface WorkerDownloadOption {
  estimatedBytes?: unknown;
  extension?: unknown;
  formatId?: unknown;
  height?: unknown;
  label?: unknown;
  workerToken?: unknown;
  width?: unknown;
}

interface WorkerResolvePayload {
  author?: unknown;
  durationSeconds?: unknown;
  mediaType?: unknown;
  options?: unknown;
  title?: unknown;
}

interface MediaDownloadTicket {
  engine: V2MediaResolverEngine;
  expiresAt: number;
  extension: string;
  filename: string;
  formatId: string;
  platform: NormalizedV2MediaInput['platform'];
  sourceUrl: string;
  userId: string;
  workerToken: string;
}

export interface V2MediaDownloadStream {
  contentLength: number;
  filename: string;
  mimeType: string;
  stream: Readable;
}

@Injectable()
export class IdBusinessV2MediaResolverService {
  private readonly resolverBaseUrl = (
    process.env.ID_BUSINESS_V2_MEDIA_RESOLVER_URL ?? 'http://127.0.0.1:8787'
  ).replace(/\/+$/u, '');
  private readonly resolveWindows = new Map<string, number[]>();
  private readonly tickets = new Map<string, MediaDownloadTicket>();
  private readonly activeResolvesByUser = new Map<string, number>();
  private readonly activeDownloadsByUser = new Map<string, number>();
  private activeResolves = 0;
  private activeDownloads = 0;

  async resolve(
    dto: ResolveIdBusinessV2MediaDto,
    operator?: AuthenticatedUser
  ): Promise<V2MediaResolveResult> {
    const userId = this.requireUserId(operator);
    const input = normalizeV2MediaInput(dto.url);
    this.reserveResolve(userId);
    this.acquireResolve(userId);

    try {
      const workerResult = await this.callResolver(input);
      return this.createResult(userId, input, workerResult);
    } finally {
      this.releaseResolve(userId);
    }
  }

  async openDownload(
    tokenInput: unknown,
    operator?: AuthenticatedUser
  ): Promise<V2MediaDownloadStream> {
    const userId = this.requireUserId(operator);
    const token = this.normalizeToken(tokenInput);
    const ticket = this.findTicket(token, userId);
    this.acquireDownload(userId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    timeout.unref?.();
    let response: Response;
    try {
      response = await fetch(`${this.resolverBaseUrl}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine: ticket.engine,
          formatId: ticket.formatId,
          platform: ticket.platform,
          url: ticket.sourceUrl,
          workerToken: ticket.workerToken
        }),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeout);
      this.releaseDownload(userId);
      if (isAbortError(error)) throw new GatewayTimeoutException('视频下载准备超时，请稍后重试');
      throw new ServiceUnavailableException('解析下载服务暂时不可用，请稍后重试');
    }

    if (!response.ok || !response.body) {
      clearTimeout(timeout);
      this.releaseDownload(userId);
      await this.throwWorkerError(response, '视频下载失败，请确认作品仍可公开访问');
    }

    const contentLength = this.readContentLength(response.headers.get('content-length'));
    if (!contentLength || contentLength > V2_MEDIA_RESOLVER_LIMITS.downloadBytes) {
      controller.abort();
      clearTimeout(timeout);
      this.releaseDownload(userId);
      throw new BadRequestException('文件过大或大小未知，当前单个文件最多支持 256 MB');
    }

    const source = Readable.from(response.body as unknown as AsyncIterable<Uint8Array>);
    let receivedBytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > V2_MEDIA_RESOLVER_LIMITS.downloadBytes) {
          controller.abort();
          callback(new Error('MEDIA_DOWNLOAD_LIMIT_EXCEEDED'));
          return;
        }
        callback(null, chunk);
      }
    });
    const stream = source.pipe(limiter);
    source.once('error', (error) => limiter.destroy(error));
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timeout);
      this.releaseDownload(userId);
    };
    stream.once('close', release);
    stream.once('end', release);
    stream.once('error', release);

    const responseExtension = normalizeDownloadExtension(
      response.headers.get('x-media-extension'),
      ticket.extension
    );
    return {
      contentLength,
      filename: replaceFilenameExtension(ticket.filename, responseExtension),
      mimeType: normalizeMediaContentType(response.headers.get('content-type'), responseExtension),
      stream
    };
  }

  private async callResolver(input: NormalizedV2MediaInput): Promise<WorkerResolvePayload> {
    let response: Response;
    try {
      response = await fetch(`${this.resolverBaseUrl}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS)
      });
    } catch (error) {
      if (isAbortError(error)) throw new GatewayTimeoutException('作品解析超时，请稍后重试');
      throw new ServiceUnavailableException('解析服务暂时不可用，请稍后重试');
    }
    if (!response.ok) {
      await this.throwWorkerError(response, '作品解析失败，请确认链接可公开访问');
    }

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > WORKER_RESPONSE_LIMIT) {
      throw new BadGatewayException('解析服务返回内容异常');
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > WORKER_RESPONSE_LIMIT) {
      throw new BadGatewayException('解析服务返回内容异常');
    }
    try {
      return JSON.parse(text) as WorkerResolvePayload;
    } catch {
      throw new BadGatewayException('解析服务返回内容异常');
    }
  }

  private async throwWorkerError(response: Response, fallback: string): Promise<never> {
    let code = '';
    try {
      const body = (await response.json()) as { code?: unknown };
      code = typeof body.code === 'string' ? body.code : '';
    } catch {
      // Worker errors are deliberately mapped to a small public message set.
    }
    if (response.status === 429 || code === 'busy') {
      throw new HttpException('解析任务较多，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (code === 'too_large') throw new BadRequestException('文件超过 256 MB，无法下载');
    if (code === 'unsupported') throw new BadRequestException('该作品类型暂不支持下载');
    if (code === 'login_required') {
      throw new BadRequestException('该作品当前需要平台登录，系统不会读取你的登录信息');
    }
    if (code === 'region_restricted') {
      throw new BadRequestException('该作品受地区访问限制，系统不会绕过平台限制');
    }
    if (code === 'private_or_missing') {
      throw new BadRequestException('作品不可公开访问、已删除或需要登录');
    }
    if (code === 'platform_limited') {
      throw new ServiceUnavailableException('来源平台暂时限制解析，请稍后重试');
    }
    if (code === 'ticket_expired') {
      throw new BadRequestException('下载凭证关联的解析结果已失效，请重新解析');
    }
    if (response.status >= 500) throw new BadGatewayException(fallback);
    throw new BadRequestException(fallback);
  }

  private createResult(
    userId: string,
    input: NormalizedV2MediaInput,
    payload: WorkerResolvePayload
  ): V2MediaResolveResult {
    const title = normalizeDisplayText(payload.title, 160, '未命名作品');
    const author = normalizeNullableDisplayText(payload.author, 100);
    const durationSeconds = normalizeNullableNumber(payload.durationSeconds, 0, 24 * 60 * 60);
    const mediaType = normalizeMediaType(payload.mediaType);
    if (!Array.isArray(payload.options) || payload.options.length === 0) {
      throw new BadGatewayException('解析服务没有返回可下载文件');
    }

    this.pruneTickets();
    const expiresAt = Date.now() + TICKET_TTL_MS;
    const rawOptions = payload.options.slice(0, V2_MEDIA_RESOLVER_LIMITS.downloadOptions);
    this.ensureTicketCapacity(userId, rawOptions.length);
    const options = rawOptions.map((rawOption, index) =>
      this.createDownloadOption(userId, input, title, rawOption, expiresAt, index)
    );

    return {
      author,
      durationSeconds,
      engine: input.engine,
      expiresAt: new Date(expiresAt).toISOString(),
      mediaType,
      options,
      platform: input.platform,
      title
    };
  }

  private createDownloadOption(
    userId: string,
    input: NormalizedV2MediaInput,
    title: string,
    rawOption: unknown,
    expiresAt: number,
    index: number
  ) {
    if (!rawOption || typeof rawOption !== 'object') {
      throw new BadGatewayException('解析服务返回的下载选项无效');
    }
    const option = rawOption as WorkerDownloadOption;
    const formatId = typeof option.formatId === 'string' ? option.formatId : '';
    const extension = typeof option.extension === 'string' ? option.extension.toLowerCase() : '';
    const workerToken = typeof option.workerToken === 'string' ? option.workerToken : '';
    if (
      !FORMAT_ID_PATTERN.test(formatId) ||
      !EXTENSION_PATTERN.test(extension) ||
      !WORKER_TOKEN_PATTERN.test(workerToken)
    ) {
      throw new BadGatewayException('解析服务返回的下载选项无效');
    }
    const label = normalizeDisplayText(option.label, 60, `下载选项 ${index + 1}`);
    const downloadToken = randomBytes(32).toString('base64url');
    const filename = buildDownloadFilename(title, label, extension, index > 0);
    this.tickets.set(downloadToken, {
      engine: input.engine,
      expiresAt,
      extension,
      filename,
      formatId,
      platform: input.platform,
      sourceUrl: input.url,
      userId,
      workerToken
    });
    return {
      downloadToken,
      estimatedBytes: normalizeNullableNumber(
        option.estimatedBytes,
        1,
        V2_MEDIA_RESOLVER_LIMITS.downloadBytes
      ),
      extension,
      height: normalizeNullableNumber(option.height, 1, 16_384),
      label,
      width: normalizeNullableNumber(option.width, 1, 16_384)
    };
  }

  private reserveResolve(userId: string) {
    const now = Date.now();
    const cutoff = now - RATE_WINDOW_MS;
    for (const [key, timestamps] of this.resolveWindows) {
      const active = timestamps.filter((timestamp) => timestamp >= cutoff);
      if (active.length) this.resolveWindows.set(key, active);
      else this.resolveWindows.delete(key);
    }
    const timestamps = (this.resolveWindows.get(userId) ?? []).filter(
      (timestamp) => timestamp >= cutoff
    );
    if (timestamps.length >= MAX_RESOLVES_PER_WINDOW) {
      throw new HttpException('解析过于频繁，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (!this.resolveWindows.has(userId) && this.resolveWindows.size >= MAX_RATE_LIMIT_USERS) {
      throw new ServiceUnavailableException('解析服务繁忙，请稍后重试');
    }
    timestamps.push(now);
    this.resolveWindows.set(userId, timestamps);
  }

  private acquireResolve(userId: string) {
    if (this.activeResolves >= MAX_ACTIVE_RESOLVES || this.activeResolvesByUser.has(userId)) {
      throw new HttpException('已有解析任务正在处理，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.activeResolves += 1;
    this.activeResolvesByUser.set(userId, 1);
  }

  private releaseResolve(userId: string) {
    this.activeResolves = Math.max(0, this.activeResolves - 1);
    this.activeResolvesByUser.delete(userId);
  }

  private acquireDownload(userId: string) {
    if (this.activeDownloads >= MAX_ACTIVE_DOWNLOADS || this.activeDownloadsByUser.has(userId)) {
      throw new HttpException('已有下载任务正在处理，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.activeDownloads += 1;
    this.activeDownloadsByUser.set(userId, 1);
  }

  private releaseDownload(userId: string) {
    this.activeDownloads = Math.max(0, this.activeDownloads - 1);
    this.activeDownloadsByUser.delete(userId);
  }

  private normalizeToken(value: unknown) {
    if (typeof value !== 'string' || !DOWNLOAD_TOKEN_PATTERN.test(value)) {
      throw new BadRequestException('下载凭证无效');
    }
    return value;
  }

  private findTicket(token: string, userId: string) {
    this.pruneTickets();
    const ticket = this.tickets.get(token);
    if (!ticket || ticket.userId !== userId) {
      throw new NotFoundException('下载凭证不存在或已过期，请重新解析');
    }
    return ticket;
  }

  private pruneTickets() {
    const now = Date.now();
    for (const [token, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(token);
    }
  }

  private ensureTicketCapacity(userId: string, requested: number) {
    if (this.tickets.size + requested > MAX_TICKETS) {
      throw new ServiceUnavailableException('下载凭证数量已达上限，请稍后重试');
    }
    let userTickets = 0;
    for (const ticket of this.tickets.values()) {
      if (ticket.userId === userId) userTickets += 1;
    }
    if (userTickets + requested > MAX_TICKETS_PER_USER) {
      throw new HttpException('待下载文件较多，请稍后重新解析', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private readContentLength(value: string | null) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  private requireUserId(operator?: AuthenticatedUser) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    return operator.id;
  }
}

function normalizeMediaType(value: unknown): V2MediaType {
  if (value === 'video' || value === 'audio' || value === 'image') return value;
  throw new BadGatewayException('解析服务返回的媒体类型无效');
}

function normalizeDisplayText(value: unknown, maxLength: number, fallback: string) {
  if (typeof value !== 'string') return fallback;
  const normalized = replaceControlCharacters(value).replace(/\s+/gu, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function normalizeNullableDisplayText(value: unknown, maxLength: number) {
  const normalized = normalizeDisplayText(value, maxLength, '');
  return normalized || null;
}

function normalizeNullableNumber(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.round(value);
  return normalized >= minimum && normalized <= maximum ? normalized : null;
}

function buildDownloadFilename(
  title: string,
  label: string,
  extension: string,
  includeLabel: boolean
) {
  const safeTitle = sanitizeFilenamePart(title) || '媒体文件';
  const safeLabel = includeLabel ? `-${sanitizeFilenamePart(label)}` : '';
  return `${safeTitle.slice(0, 100)}${safeLabel.slice(0, 40)}.${extension}`;
}

function sanitizeFilenamePart(value: string) {
  return value
    .normalize('NFKC')
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? '_' : character;
    })
    .join('')
    .replace(/[\\/:*?"<>|]/gu, '_')
    .replace(/[. ]+$/gu, '')
    .trim();
}

function replaceControlCharacters(value: string) {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : character;
  }).join('');
}

function normalizeMediaContentType(value: string | null, extension: string) {
  const candidate = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (candidate && /^(?:video|audio|image)\/[a-z0-9.+-]+$/u.test(candidate)) return candidate;
  const byExtension: Record<string, string> = {
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    m4a: 'audio/mp4',
    mkv: 'video/x-matroska',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    png: 'image/png',
    webm: 'video/webm',
    webp: 'image/webp'
  };
  return byExtension[extension] ?? 'application/octet-stream';
}

function normalizeDownloadExtension(value: string | null, fallback: string) {
  const normalized = value?.trim().toLowerCase() ?? '';
  return EXTENSION_PATTERN.test(normalized) ? normalized : fallback;
}

function replaceFilenameExtension(filename: string, extension: string) {
  return `${filename.replace(/\.[a-z0-9]{1,8}$/iu, '')}.${extension}`;
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
