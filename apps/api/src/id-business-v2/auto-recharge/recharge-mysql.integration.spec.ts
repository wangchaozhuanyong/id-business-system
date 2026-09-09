import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { RechargeService } from './recharge.service';

const url = process.env.V2_RECHARGE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('recharge real MySQL restart and concurrency', () => {
  let prisma: PrismaService;
  let service: RechargeService;
  const ownerId = randomUUID();
  const operator = {
    id: ownerId,
    username: 'recharge-test',
    displayName: '隔离验收',
    roles: ['admin'],
    permissions: []
  };
  const createService = () =>
    new RechargeService(
      new RechargeRepository(prisma),
      new RechargeAddressRepository(prisma),
      new V2CommandTransactionManager(prisma),
      new V2TransactionalAuditService()
    );

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (parsed.hostname !== '127.0.0.1' || !parsed.pathname.includes('financial_integrity_'))
      throw new Error('仅允许隔离验收库');
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
    await prisma.user.create({
      data: {
        id: ownerId,
        username: 'recharge-' + ownerId,
        displayName: '隔离验收',
        passwordHash: 'test-only-not-valid-password'
      }
    });
    service = createService();
    vi.stubEnv('AUTO_RECHARGE_WORKER_TOKEN', 'fixture'.repeat(12));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('dispatches once under concurrency, restores records after API restart, and prevents stale overwrite', async () => {
    const id = randomUUID();
    const input = {
      id,
      plan: 'plus',
      action: 'quote',
      sessionJson: '{"sessionToken":"fixture-private"}'
    };
    const starts = await Promise.allSettled([
      service.start({ ...input }, operator),
      service.start({ ...input }, operator)
    ]);
    expect(starts.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    const accountKey = 'c'.repeat(64);
    await service.callback(id, { type: 'restore', accountKey });
    const document = {
      schema_version: 2,
      target_plan: 'plus',
      plan: 'chatgptplusplan',
      checkout_identifier: 'cs_fixture_original',
      processor_entity: 'fixture',
      payment_status: 'not_attempted'
    };
    await service.callback(id, {
      type: 'ledger',
      accountKey,
      fileKey: accountKey + '.json',
      revision: 0,
      document
    });
    await expect(
      service.callback(id, {
        type: 'ledger',
        accountKey,
        fileKey: accountKey + '.json',
        revision: 0,
        document
      })
    ).rejects.toThrow();
    await service.callback(id, { type: 'finished', result: { status: 'checkout_quote_verified' } });
    service = createService();
    const restoredId = randomUUID();
    await service.start({ ...input, id: restoredId, action: 'recheck' }, operator);
    const result = await service.callback(restoredId, { type: 'restore', accountKey });
    expect(result).toMatchObject({ records: [{ revision: 1, document }] });
    const stored = await prisma.idBusinessV2RechargeJob.findMany({ where: { ownerId } });
    expect(JSON.stringify(stored)).not.toContain('fixture-private');
    await expect(
      service.callback(restoredId, {
        type: 'ledger',
        accountKey,
        fileKey: accountKey + '.json',
        revision: 1,
        document: { ...document, checkout_identifier: 'cs_different' }
      })
    ).rejects.toThrow('不可更换');
    await service.callback(restoredId, {
      type: 'finished',
      result: { status: 'payment_result_unknown' }
    });
  });
});
