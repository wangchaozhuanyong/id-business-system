import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { OnlineRechargeEphemeralCredentials } from './ephemeral-credentials.service';
import { OnlineRechargeTasksService } from './tasks.service';

@Injectable()
export class OnlineRechargeProgressWebsocket implements OnApplicationBootstrap, OnModuleDestroy {
  private server?: WebSocketServer;
  private http?: Server;
  private timers = new Set<ReturnType<typeof setInterval>>();
  private upgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  constructor(
    private readonly host: HttpAdapterHost,
    private readonly config: ConfigService,
    private readonly credentials: OnlineRechargeEphemeralCredentials,
    private readonly tasks: OnlineRechargeTasksService
  ) {}
  onApplicationBootstrap() {
    this.http = this.host.httpAdapter.getHttpServer() as Server;
    this.server = new WebSocketServer({
      noServer: true,
      maxPayload: 4096,
      perMessageDeflate: false
    });
    this.upgrade = (request, socket, head) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path !== '/api/id-business-v2/online-recharge/ws') return;
      const origins =
        this.config
          .get<string>('CORS_ORIGIN')
          ?.split(',')
          .map((origin) => origin.trim())
          .filter(Boolean) ?? [];
      if (request.headers.origin && origins.length && !origins.includes(request.headers.origin)) {
        socket.destroy();
        return;
      }
      this.server!.handleUpgrade(request, socket, head, (ws) => this.connect(ws));
    };
    this.http.on('upgrade', this.upgrade);
  }
  private connect(socket: WebSocket) {
    let taskId: string | null = null,
      busy = false;
    const deadline = setTimeout(() => {
      if (!taskId) socket.close(1008, '任务授权超时');
    }, 5000);
    const refresh = async () => {
      if (!taskId || busy || socket.readyState !== WebSocket.OPEN) return;
      busy = true;
      try {
        const task = await this.tasks.get(taskId, true);
        socket.send(JSON.stringify({ type: 'snapshot', task, ...task }));
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: '读取进度失败，请重连后重试' }));
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => {
      void refresh();
    }, 2000);
    this.timers.add(timer);
    // 定期重新取得HTTP授权票，使退出登录/撤销权限能够及时收敛。
    const reauthorize = setTimeout(() => socket.close(1000, '请刷新任务授权'), 60000);
    socket.on('message', (data) => {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        socket.close(1008, '消息格式无效');
        return;
      }
      if (input.type === 'ping' && taskId) {
        socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (taskId || input.type !== 'subscribe' || typeof input.ticket !== 'string') {
        socket.close(1008, '任务授权无效');
        return;
      }
      taskId = this.credentials.redeemTicket(input.ticket);
      if (!taskId) {
        socket.close(1008, '任务授权无效');
        return;
      }
      clearTimeout(deadline);
      void refresh();
    });
    socket.on('close', () => {
      clearTimeout(deadline);
      clearTimeout(reauthorize);
      clearInterval(timer);
      this.timers.delete(timer);
    });
    socket.on('error', () => socket.close());
  }
  onModuleDestroy() {
    if (this.upgrade) this.http?.off('upgrade', this.upgrade);
    for (const timer of this.timers) clearInterval(timer);
    for (const socket of this.server?.clients ?? []) socket.close();
    this.server?.close();
  }
}
