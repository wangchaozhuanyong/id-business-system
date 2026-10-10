import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  HttpException,
  ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { REGISTRATION_WORKSPACE_PATH } from '../../auth/registration-workspace-session';
import { isWorkspaceSensitiveRead, workspaceUpstreamPath } from './workspace-path';

export interface WorkspaceRequest extends IncomingMessage {
  originalUrl: string;
  body?: unknown;
}

const sourceCommit = '93ab9842004adc263f2089a07f281ec34a7560d7';
const origin = 'http://127.0.0.1:55323';

@Injectable()
export class AutoRegistrationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoRegistrationService.name);
  private readonly projectRoot = resolve(__dirname, '../../../../..');
  private readonly runtimeDirectory = resolve(this.projectRoot, '.runtime/auto-registration');
  private readonly internalToken = randomBytes(32).toString('hex');
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private readonly streams = new Set<WebSocket>();
  private readonly channels = new Map<string, { socket: WebSocket; path: string }>();

  constructor(
    private readonly config: ConfigService,
    private readonly audit: AuditLogsService
  ) {}

  onModuleInit() {
    // A missing optional Python runtime must not prevent existing business modules from starting.
    void this.start().catch(() =>
      this.logger.warn(
        this.config.get<string>('NODE_ENV') === 'production'
          ? '自动注册未启动，请检查镜像资源、运行依赖和持久化目录'
          : '自动注册未启动，请运行 npm run auto-registration:setup'
      )
    );
  }

  onModuleDestroy() {
    for (const socket of this.streams) socket.close();
    this.child?.kill('SIGTERM');
    this.child = null;
  }

  async status() {
    await this.start();
    await this.requireWorkerHealth();
    return {
      ready: true,
      workspacePath: `${REGISTRATION_WORKSPACE_PATH}/`,
      version: '1.0.4',
      sourceCommit
    };
  }

  async appleMailboxRequest<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
    if (!/^\/internal\/apple-mailboxes(?:\/[a-z0-9-]+)*$/.test(path)) throw this.unavailable();
    await this.start();
    let response: globalThis.Response;
    try {
      response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          'X-ID-Workspace-Token': this.internalToken,
          'Content-Type': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000)
      });
    } catch {
      throw this.unavailable();
    }
    if (!response.ok) {
      const messages: Record<number, string> = {
        400: '邮箱信息或标记内容无效，请核对输入',
        404: '邮箱记录或注册任务不存在，请刷新后重试',
        409: '邮箱状态或任务占用已变化，请刷新列表后重试'
      };
      if (messages[response.status])
        throw new HttpException(messages[response.status]!, response.status);
      throw this.unavailable();
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw this.unavailable();
    }
  }

  private start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.launch().catch((error: unknown) => {
      this.starting = null;
      throw error;
    });
    return this.starting;
  }

  private async launch() {
    const python =
      this.config.get<string>('NODE_ENV') === 'production'
        ? '/opt/id-registration/venv/bin/python'
        : resolve(this.runtimeDirectory, 'venv/bin/python');
    const entry = resolve(
      this.projectRoot,
      'apps/api/src/id-business-v2/auto-registration/worker/workspace.py'
    );
    if (!existsSync(python) || !existsSync(entry)) throw this.unavailable();
    const encryptionKey = this.config.get<string>('FIELD_ENCRYPTION_KEY');
    if (!encryptionKey) throw this.unavailable();
    mkdirSync(this.runtimeDirectory, { recursive: true, mode: 0o700 });
    const child = spawn(python, ['-B', entry], {
      cwd: this.runtimeDirectory,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { PATH: process.env.PATH, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' }
    });
    this.child = child;
    let stopped = false;
    child.once('error', () => {
      stopped = true;
    });
    child.once('exit', () => {
      stopped = true;
      if (this.child === child) {
        this.child = null;
        this.starting = null;
      }
      for (const socket of this.streams) socket.close();
    });
    // Credentials stay in process memory and the private pipe, never command arguments or disk.
    child.stdin?.end(
      JSON.stringify({
        internalToken: this.internalToken,
        encryptionKey,
        runtimeDir: this.runtimeDirectory,
        port: 55323
      }) + '\n'
    );
    for (let attempt = 0; attempt < 40 && !stopped; attempt += 1) {
      try {
        await this.requireWorkerHealth();
        return;
      } catch {
        /* The private service is still starting. */
      }
      await new Promise((done) => setTimeout(done, 250));
    }
    child.kill('SIGTERM');
    throw this.unavailable();
  }

  private async requireWorkerHealth() {
    try {
      const response = await fetch(`${origin}/health`, {
        headers: { 'X-ID-Workspace-Token': this.internalToken },
        signal: AbortSignal.timeout(1000)
      });
      if (!response.ok) throw this.unavailable();
      const health = (await response.json()) as Record<string, unknown>;
      if (
        health.status !== 'ready' ||
        health.database !== 'isolated-sqlite' ||
        health.upstream !== sourceCommit.slice(0, 7)
      )
        throw this.unavailable();
    } catch {
      throw this.unavailable();
    }
  }

  async proxy(
    request: WorkspaceRequest,
    response: ServerResponse,
    operator: AuthenticatedUser,
    revalidate: () => Promise<boolean>
  ) {
    const path = workspaceUpstreamPath(request.originalUrl);
    const method = request.method ?? 'GET';
    await this.start();
    const sensitive = isWorkspaceSensitiveRead(method, path);
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (mutating || sensitive) {
      // Fail closed before allowing either a mutation or a full credential response.
      await this.audit.create({
        userId: operator.id,
        module: '自动注册',
        action: sensitive ? '敏感查看或导出' : '操作请求',
        objectType: '开源注册模块',
        remark: `${method} ${path.split('?')[0]}`
      });
    }
    if (/^\/api\/ws\/(?:task|batch)\/[^/?]+$/.test(path.split('?')[0]!)) {
      const streamId = new URL(`${origin}${path}`).searchParams.get('streamId');
      if (!streamId || !/^[a-f0-9-]{36}$/.test(streamId)) throw this.unavailable();
      const channelKey = `${operator.id}:${streamId}`;
      const socketPath = path.split('?')[0]!;
      if (method === 'GET') this.stream(socketPath, response, channelKey, revalidate);
      else if (method === 'POST') {
        const channel = this.channels.get(channelKey);
        const command = request.body as { type?: string } | undefined;
        if (
          !channel ||
          channel.path !== socketPath ||
          channel.socket.readyState !== WebSocket.OPEN ||
          !['ping', 'cancel'].includes(command?.type ?? '')
        )
          throw this.unavailable();
        channel.socket.send(JSON.stringify({ type: command!.type }));
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json');
        response.end('{"accepted":true}');
      } else throw this.unavailable();
      return;
    }
    const headers: Record<string, string> = { 'X-ID-Workspace-Token': this.internalToken };
    if (sensitive) headers['X-ID-Workspace-Sensitive-Access'] = 'audited';
    const contentType = request.headers['content-type'];
    if (typeof contentType === 'string') headers['Content-Type'] = contentType;
    let body: Uint8Array<ArrayBuffer> | string | undefined;
    if (mutating) {
      if (request.body !== undefined) body = JSON.stringify(request.body);
      else {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const value = Buffer.from(chunk);
          size += value.length;
          if (size > 10 * 1024 * 1024) throw this.unavailable();
          chunks.push(value);
        }
        if (size) body = Uint8Array.from(Buffer.concat(chunks));
      }
    }
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${origin}${path}`, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(120_000)
      });
    } catch {
      throw this.unavailable();
    }
    response.statusCode = upstream.status;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'; frame-src 'none'; form-action 'self'; base-uri 'none'; object-src 'none'"
    );
    for (const name of ['content-type', 'content-disposition']) {
      const value = upstream.headers.get(name);
      if (value) response.setHeader(name, value);
    }
    response.end(Buffer.from(await upstream.arrayBuffer()));
    if (mutating) {
      await this.audit.create({
        userId: operator.id,
        module: '自动注册',
        action: upstream.ok ? '操作完成' : '操作失败',
        objectType: '开源注册模块',
        remark: `${method} ${path.split('?')[0]} · ${upstream.status}`
      });
    }
  }

  private stream(
    path: string,
    response: ServerResponse,
    channelKey: string,
    revalidate: () => Promise<boolean>
  ) {
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}${path}`, [this.internalToken]);
    this.streams.add(socket);
    this.channels.get(channelKey)?.socket.close();
    this.channels.set(channelKey, { socket, path });
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    socket.addEventListener('open', () => response.write('event: connected\ndata: {}\n\n'));
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') response.write(`data: ${JSON.stringify(event.data)}\n\n`);
    });
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clearInterval(revalidation);
      socket.close();
      this.streams.delete(socket);
      if (this.channels.get(channelKey)?.socket === socket) this.channels.delete(channelKey);
      response.end();
    };
    // Keep the original upstream socket alive to avoid dropping logs during reconnection.
    let checking = false;
    const revalidation = setInterval(() => {
      if (checking || disposed) return;
      checking = true;
      void revalidate()
        .then((allowed) => {
          if (!allowed) dispose();
        })
        .catch(dispose)
        .finally(() => {
          checking = false;
        });
    }, 15_000);
    socket.addEventListener('close', dispose, { once: true });
    socket.addEventListener('error', dispose, { once: true });
    response.once('close', dispose);
  }

  private unavailable() {
    return new ServiceUnavailableException('自动注册服务尚未就绪，请检查运行环境后重试');
  }
}
