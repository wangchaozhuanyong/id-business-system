import express from 'express';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOnlineRechargeWorkerBodyParser,
  createOnlineRechargeBodyParser
} from './worker-body-parser';

describe('线上代充内部正文鉴权边界', () => {
  let server: Server;
  let origin: string;
  const key = randomBytes(32).toString('base64url');
  const previous = process.env.ONLINE_RECHARGE_WORKER_KEY;
  beforeAll(async () => {
    process.env.ONLINE_RECHARGE_WORKER_KEY = key;
    const app = express();
    app.use(
      '/api/id-business-v2/online-recharge/worker/rpc',
      createOnlineRechargeWorkerBodyParser()
    );
    app.use('/api/id-business-v2/online-recharge', createOnlineRechargeBodyParser());
    app.use(express.json());
    app.post('/api/id-business-v2/online-recharge/worker/rpc', (req, res) =>
      res.json({ bytes: req.body.data.length })
    );
    app.post('/api/ordinary', (_req, res) => res.json({ ok: true }));
    app.post('/api/id-business-v2/online-recharge/admin/cards/import', (req, res) =>
      res.json({
        bytes: req.body.data.length,
        rawBody: Boolean((req as express.Request & { rawBody?: Buffer }).rawBody)
      })
    );
    app.post('/api/id-business-v2/online-recharge/webhooks/card-issue', (req, res) =>
      res.json({
        rawMatches:
          (req as express.Request & { rawBody?: Buffer }).rawBody?.toString('utf8') ===
          JSON.stringify(req.body)
      })
    );
    app.post('/api/id-business-v2/online-recharge/public/submit', (_req, res) =>
      res.json({ ok: true })
    );
    app.use(
      (
        error: { status?: number },
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction
      ) => {
        void _next;
        res.status(error.status ?? 500).json({ message: '请求被拒绝' });
      }
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('隔离监听未建立');
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.ONLINE_RECHARGE_WORKER_KEY;
    else process.env.ONLINE_RECHARGE_WORKER_KEY = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const post = (path: string, body: string, token?: string) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-online-recharge-worker': token } : {})
      },
      body
    });
  const rpc = '/api/id-business-v2/online-recharge/worker/rpc';
  it('无凭证的大型无效正文在解析前拒绝', async () => {
    expect((await post(rpc, 'invalid'.repeat(30000))).status).toBe(401);
  });
  it('错误凭证不能上传媒体', async () => {
    expect((await post(rpc, '{', randomBytes(32).toString('base64url'))).status).toBe(401);
  });
  it('受控内部正文允许超过普通 JSON 上限', async () => {
    const response = await post(rpc, JSON.stringify({ data: 'x'.repeat(200000) }), key);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: 200000 });
  });
  it('其他接口保留原有正文上限', async () => {
    expect(
      (await post('/api/ordinary', JSON.stringify({ data: 'x'.repeat(200000) }), key)).status
    ).toBe(413);
  });
  it('正确凭证不能绕过 JSON 校验', async () => {
    expect((await post(rpc, '{', key)).status).toBe(400);
  });
  it('原批量资源容量可达，管理员正文不建立原始凭据副本', async () => {
    const response = await post(
      '/api/id-business-v2/online-recharge/admin/cards/import',
      JSON.stringify({ data: 'x'.repeat(200000) })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: 200000, rawBody: false });
  });
  it('补货回调保留精确原始正文供验签，客户正文仍受小容量约束', async () => {
    const response = await post(
      '/api/id-business-v2/online-recharge/webhooks/card-issue',
      JSON.stringify({ data: 'x'.repeat(200000) })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rawMatches: true });
    expect(
      (
        await post(
          '/api/id-business-v2/online-recharge/public/submit',
          JSON.stringify({ data: 'x'.repeat(400000) })
        )
      ).status
    ).toBe(413);
  });
});
