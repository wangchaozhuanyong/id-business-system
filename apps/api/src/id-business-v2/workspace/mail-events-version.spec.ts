import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { V2ChangeEventPublisher } from '../../common/prisma/v2-change-event.publisher';
import { V2CommandTransactionManager } from '../runtime/id-business-v2-command-transaction.service';
import { V2TransactionalAuditService } from '../runtime/persistence/id-business-v2-transactional-audit.repository';
import { MailEventsService } from './mail-events.service';
import { MailEventRepository } from './persistence/mail-event.repository';

function fixture(version?: bigint) {
  type Receipt = {
    id: string;
    payloadHash: string;
    virtualEmailId: string | null;
    processedAt: Date | null;
  };
  let committed = {
    version,
    receipts: new Map<string, Receipt>(),
    audits: [] as unknown[]
  };
  let failVersion = false;
  const prisma = {
    idBusinessV2ScopeVersion: {
      findMany: vi.fn(async () =>
        committed.version === undefined
          ? []
          : [{ scope: 'vendure-mailbox', version: committed.version }]
      )
    },
    idBusinessV2MailboxEvent: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => committed.receipts.get(where.id) ?? null
      ),
      updateMany: vi.fn(async ({ where }: { where: { id: string } }) => {
        committed.receipts.get(where.id)!.processedAt = new Date();
        return { count: 1 };
      })
    },
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      const staged = structuredClone(committed);
      const result = await work({
        idBusinessV2MailboxEvent: {
          create: async ({ data }: { data: Omit<Receipt, 'processedAt'> }) => {
            const row = { ...data, processedAt: null };
            staged.receipts.set(row.id, row);
            return row;
          }
        },
        auditLog: {
          create: async ({ data }: { data: unknown }) => {
            staged.audits.push(data);
          }
        },
        idBusinessV2ScopeVersion: {
          upsert: async ({
            create,
            update
          }: {
            create: { version: number };
            update: { version: { increment: number } };
          }) => {
            if (failVersion) throw new Error('version write failed');
            staged.version =
              staged.version === undefined
                ? BigInt(create.version)
                : staged.version + BigInt(update.version.increment);
          }
        }
      });
      committed = staged;
      return result;
    })
  };
  const publisher = new V2ChangeEventPublisher(prisma as never);
  const changes: unknown[] = [];
  publisher.events().subscribe((message) => changes.push(message));
  const service = new MailEventsService(
    new MailEventRepository(prisma as never),
    new V2CommandTransactionManager(prisma as never, publisher),
    new V2TransactionalAuditService(),
    { get: () => undefined } as never
  );
  const event = () => ({
    schemaVersion: 1 as const,
    eventId: randomUUID(),
    primaryAccountId: '1',
    virtualEmailId: null,
    occurredAt: new Date().toISOString()
  });
  return {
    service,
    changes,
    event,
    state: () => committed,
    setFailure: (value: boolean) => {
      failVersion = value;
    }
  };
}

describe('邮件回执与页面变更版本的事务闭环', () => {
  it('已有数据库缺少邮箱版本时，第一封邮件仍发布版本 1，重复回执不重复更新', async () => {
    const f = fixture();
    const event = f.event();
    await f.service.accept(event);
    await vi.waitFor(() => expect(f.changes).toHaveLength(1));
    expect(f.changes[0]).toMatchObject({
      type: 'change',
      event: { scopes: [{ scope: 'vendure-mailbox', version: '1' }] }
    });
    await f.service.accept(event);
    expect(f.state().version).toBe(1n);
    expect(f.state().receipts.size).toBe(1);
    expect(f.state().audits).toHaveLength(1);
    expect(f.changes).toHaveLength(1);
    await f.service.accept(f.event());
    await vi.waitFor(() => expect(f.changes).toHaveLength(2));
    expect(f.changes[1]).toMatchObject({
      type: 'change',
      event: { scopes: [{ scope: 'vendure-mailbox', version: '2' }] }
    });
  });

  it('保留已有大整数版本，不能重新初始化或丢失精度', async () => {
    const f = fixture(9007199254740993n);
    await f.service.accept(f.event());
    await vi.waitFor(() => expect(f.changes).toHaveLength(1));
    expect(f.state().version).toBe(9007199254740994n);
    expect(f.changes[0]).toMatchObject({
      type: 'change',
      event: { scopes: [{ scope: 'vendure-mailbox', version: '9007199254740994' }] }
    });
  });

  it('版本保存失败时回滚回执和审计，不发页面事件；相同通知重投后恢复', async () => {
    const f = fixture();
    const event = f.event();
    f.setFailure(true);
    await expect(f.service.accept(event)).rejects.toThrow('version write failed');
    expect(f.state().version).toBeUndefined();
    expect(f.state().receipts.size).toBe(0);
    expect(f.state().audits).toHaveLength(0);
    expect(f.changes).toHaveLength(0);
    f.setFailure(false);
    await f.service.accept(event);
    await vi.waitFor(() => expect(f.changes).toHaveLength(1));
    expect(f.state().version).toBe(1n);
    expect(f.state().receipts.size).toBe(1);
  });
});
