import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { OnlineRechargeEphemeralCredentials } from './ephemeral-credentials.service';

const engine = createRequire(resolve(__dirname, 'ephemeral-credentials.spec.ts'))(
  './engine/credentials.cjs'
) as {
  start(input: { url: string; key: string }): Promise<{ server: Server; close(): Promise<void> }>;
  take(cardId: string, taskId: string): string;
  cleanup(): void;
};

describe('API到实际执行器的临时安全码通道', () => {
  it('只透传到执行器内存，实际预约期间不可覆盖，关闭执行器后清空', async () => {
    const key = randomBytes(32).toString('base64url');
    const runtime = await engine.start({ url: 'http://127.0.0.1:0', key });
    const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    const api = new OnlineRechargeEphemeralCredentials(
      new ConfigService({ ONLINE_RECHARGE_WORKER_KEY: key, ONLINE_RECHARGE_CREDENTIALS_URL: url })
    );
    const cardId = randomUUID();
    const taskId = randomUUID();
    try {
      await api.putCvc(cardId, '123');
      expect(await api.available([cardId])).toEqual([cardId]);
      const firstRead = await api.forBitBrowser(cardId);
      expect(firstRead.cvc).toBe('123');
      expect(firstRead.state).toBe('available');
      expect(Date.parse(firstRead.expiresAt!)).toBeLessThanOrEqual(Date.now() + 86400000);
      expect(engine.take(cardId, taskId)).toBe('123');
      expect(await api.forBitBrowser(cardId)).toEqual({
        cvc: null,
        expiresAt: null,
        state: 'busy'
      });
      await expect(api.putCvc(cardId, '456')).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(engine.take(cardId, randomUUID())).toBe('');
      expect(Object.values(api).filter((value) => value instanceof Map)).toHaveLength(1);
      await api.forgetCvc(cardId);
      expect(await api.available([cardId])).toEqual([]);
    } finally {
      await runtime.close();
    }
    expect(engine.take(cardId, taskId)).toBe('');
    expect(await api.available([cardId])).toEqual([]);
  });
  it('临时安全码到期或执行器重启后，比特读取不返回秘密', async () => {
    const key = randomBytes(32).toString('base64url');
    const runtime = await engine.start({ url: 'http://127.0.0.1:0', key });
    const api = new OnlineRechargeEphemeralCredentials(
      new ConfigService({
        ONLINE_RECHARGE_WORKER_KEY: key,
        ONLINE_RECHARGE_CREDENTIALS_URL: `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`
      })
    );
    const cardId = randomUUID();
    const now = Date.now();
    try {
      await api.putCvc(cardId, '123');
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 86401000);
      engine.cleanup();
      expect(await api.forBitBrowser(cardId)).toEqual({
        cvc: null,
        expiresAt: null,
        state: 'unavailable'
      });
      clock.mockRestore();
    } finally {
      vi.restoreAllMocks();
      await runtime.close();
    }
  });
});
