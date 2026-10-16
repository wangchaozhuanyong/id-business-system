import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';
import { V2ChangeEventPublisher } from '../../common/prisma/v2-change-event.publisher';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { MailEventsService } from './mail-events.service';
import { MailEventRepository } from './persistence/mail-event.repository';

const enabled = process.env.MAILBOX_VERSION_MYSQL_TEST === '1';
(enabled ? describe : describe.skip)('邮箱变更版本真实 MySQL 事务', () => {
  const db = new PrismaService();
  const publisher = new V2ChangeEventPublisher(db);
  const changes: unknown[] = [];
  const subscription = publisher.events().subscribe((message) => changes.push(message));
  const service = new MailEventsService(
    new MailEventRepository(db),
    new V2CommandTransactionManager(db, publisher),
    new V2TransactionalAuditService(),
    { get: () => undefined } as never
  );
  const ids: string[] = [];
  const scope = 'vendure-mailbox';
  const version = () => db.idBusinessV2ScopeVersion.findUniqueOrThrow({ where: { scope } });
  function event() {
    const eventId = randomUUID();
    ids.push(eventId);
    return {
      schemaVersion: 1 as const,
      eventId,
      primaryAccountId: 'ci-fixture',
      virtualEmailId: null,
      occurredAt: new Date().toISOString()
    };
  }
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (
      process.env.GITHUB_ACTIONS !== 'true' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/id_business_v2_mailbox_version_fixture'
    ) {
      throw new Error('邮箱事务验收仅允许云端自有隔离数据库');
    }
    await db.$connect();
    await db.idBusinessV2ScopeVersion.deleteMany({ where: { scope } });
  });
  afterAll(async () => {
    subscription.unsubscribe();
    await db.idBusinessV2MailboxEvent.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });
  it('未预置版本的数据库收到首封邮件后发布版本 1', async () => {
    await service.accept(event());
    expect((await version()).version).toBe(1n);
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]).toMatchObject({
      type: 'change',
      event: { scopes: [{ scope, version: '1' }] }
    });
  });
  it('重复回执只提交一次版本与事件', async () => {
    const value = event();
    await service.accept(value);
    await service.accept(value);
    expect((await version()).version).toBe(2n);
    expect(await db.idBusinessV2MailboxEvent.count({ where: { id: value.eventId } })).toBe(1);
  });
  it('缺少初始版本时并发通知和有界重投不丢失版本', async () => {
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    await db.idBusinessV2ScopeVersion.deleteMany({ where: { scope } });
    const values = Array.from({ length: 4 }, event);
    await Promise.all(
      values.map(async (value) => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            await service.accept(value);
            return;
          } catch (error) {
            if (attempt >= 4) throw error;
          }
        }
      })
    );
    expect((await version()).version).toBe(4n);
    expect(
      await db.idBusinessV2MailboxEvent.count({
        where: { id: { in: values.map((value) => value.eventId) } }
      })
    ).toBe(4);
  });
  it('版本保存失败时真实回滚回执，恢复后相同通知可以重投', async () => {
    const value = event();
    await db.idBusinessV2ScopeVersion.update({
      where: { scope },
      data: { version: 9223372036854775807n }
    });
    await expect(service.accept(value)).rejects.toBeDefined();
    expect(
      await db.idBusinessV2MailboxEvent.findUnique({ where: { id: value.eventId } })
    ).toBeNull();
    expect((await version()).version).toBe(9223372036854775807n);
    await db.idBusinessV2ScopeVersion.update({ where: { scope }, data: { version: 4n } });
    await service.accept(value);
    expect((await version()).version).toBe(5n);
  });
});
