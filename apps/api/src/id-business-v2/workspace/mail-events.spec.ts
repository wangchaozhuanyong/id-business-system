import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyMailEvent } from './mail-event';
import { MailEventsService } from './mail-events.service';

const secret = 'synthetic-mail-signing-secret-for-local-tests';
const event = {
  schemaVersion: 1 as const,
  eventId: '11111111-1111-4111-8111-111111111111',
  primaryAccountId: 'primary-1',
  virtualEmailId: 'alias-1',
  occurredAt: new Date().toISOString()
};
const sign = (value: object, timestamp: string) =>
  createHmac('sha256', secret)
    .update(`${timestamp}.${JSON.stringify(value)}`)
    .digest('hex');

describe('邮件通知认证', () => {
  it('只接受新鲜、完整签名的最小元数据', () => {
    const timestamp = String(Date.now());
    expect(verifyMailEvent(event, timestamp, sign(event, timestamp), secret)).toEqual(event);
    expect(() => verifyMailEvent(event, timestamp, '0'.repeat(64), secret)).toThrow('授权无效');
    const stale = String(Date.now() - 600_000);
    expect(() => verifyMailEvent(event, stale, sign(event, stale), secret)).toThrow('授权无效');
    expect(() =>
      verifyMailEvent({ ...event, code: '123456' }, timestamp, sign(event, timestamp), secret)
    ).toThrow('格式无效');
    expect(() => verifyMailEvent(event, timestamp, sign(event, timestamp))).toThrow('尚未配置');
  });
});

function fixture() {
  let receipt: {
    id: string;
    virtualEmailId: string | null;
    payloadHash: string;
    processedAt: Date | null;
  } | null = null;
  const repository = {
    find: vi.fn(async () => receipt),
    pending: vi.fn(async () => (receipt && !receipt.processedAt ? [receipt] : [])),
    create: vi.fn(
      async (_tx, value, hash) =>
        (receipt = {
          id: value.eventId,
          virtualEmailId: value.virtualEmailId,
          payloadHash: hash,
          processedAt: null
        })
    ),
    processed: vi.fn(async () => {
      receipt!.processedAt = new Date();
    })
  };
  const transactions = {
    execute: vi.fn(async (work: (tx: unknown) => unknown, options: unknown) => {
      void options;
      return work({});
    })
  };
  const audit = { append: vi.fn() };
  const service = new MailEventsService(
    repository as never,
    transactions as never,
    audit as never,
    { get: () => secret } as never
  );
  return { service, repository, transactions, audit };
}

describe('邮件事件持久回执', () => {
  afterEach(() => vi.useRealTimers());
  it('同一通知只发布一次变更、只唤醒一次任务', async () => {
    const f = fixture();
    const handler = vi.fn().mockResolvedValue(undefined);
    f.service.subscribe(handler);
    await f.service.accept(event);
    await f.service.accept(event);
    expect(f.transactions.execute).toHaveBeenCalledTimes(1);
    expect(f.transactions.execute.mock.calls[0][1]).toMatchObject({
      changedScopes: ['vendure-mailbox']
    });
    expect(handler).toHaveBeenCalledExactlyOnceWith('alias-1');
    expect(f.audit.append.mock.calls[0][1]).not.toHaveProperty('afterData');
  });
  it('投递失败保留待处理回执，重发后恢复；不同内容不能冒用同一事件编号', async () => {
    const f = fixture();
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport unavailable'))
      .mockResolvedValue(undefined);
    f.service.subscribe(handler);
    await expect(f.service.accept(event)).rejects.toThrow('transport unavailable');
    expect(f.repository.processed).not.toHaveBeenCalled();
    await f.service.accept(event);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(f.transactions.execute).toHaveBeenCalledTimes(1);
    await expect(f.service.accept({ ...event, virtualEmailId: 'other-alias' })).rejects.toThrow(
      '已被使用'
    );
  });
  it('启动恢复待处理通知，队列清空后不定时查询', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(undefined);
    f.service.subscribe(handler);
    await expect(f.service.accept(event)).rejects.toThrow('unavailable');
    f.service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.repository.processed).toHaveBeenCalledTimes(1);
    const reads = f.repository.pending.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.repository.pending).toHaveBeenCalledTimes(reads);
    f.service.onModuleDestroy();
  });
});
