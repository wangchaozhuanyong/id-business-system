import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { RechargeService } from './recharge.service';
import { RechargeLocalService } from './recharge-local.service';

const url = process.env.V2_RECHARGE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('recharge real MySQL restart and concurrency', () => {
  let prisma: PrismaService;
  let service: RechargeService;
  let local: RechargeLocalService;
  const ownerId = randomUUID();
  const addressId = randomUUID();
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
  const createLocalService = () =>
    new RechargeLocalService(
      new RechargeRepository(prisma),
      new RechargeAddressRepository(prisma),
      {
        runtime: vi.fn().mockResolvedValue({
          connectorUrl: 'http://127.0.0.1:55322',
          connectorToken: 'fixture-private',
          localApiUrl: 'http://127.0.0.1:54345',
          localApiToken: 'fixture-private',
          groupName: '充值验收',
          tagName: '本地合成',
          proxyType: 'http',
          dynamicProxyUrl: '',
          browserOptions: V2_RECHARGE_BROWSER_DEFAULTS
        })
      } as never,
      service,
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
    await prisma.idBusinessV2RechargeAddress.create({
      data: { id: addressId, ownerId, line1: '1221 SW Fourth Avenue' }
    });
    service = createService();
    local = createLocalService();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('creates one owned BitBrowser task under concurrency, restores records after API restart, and prevents stale overwrite', async () => {
    const id = randomUUID();
    const input = {
      id,
      plan: 'plus',
      addressId,
      windowName: '本地合成充值',
      lockedCurrency: 'USD',
      maxAmount: '30.00',
      authorizeSinglePayment: true
    };
    await expect(service.start(input, operator)).rejects.toThrow('服务器充值已停用');
    const starts = await Promise.allSettled([
      local.start({ ...input }, operator),
      local.start({ ...input }, operator)
    ]);
    const successful = starts.filter((result) => result.status === 'fulfilled');
    const rejected = starts.filter((result) => result.status === 'rejected');
    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason.message).toContain('连接凭据已失效');
    const launch = successful[0]!.value;
    expect(await prisma.idBusinessV2RechargeJob.count({ where: { ownerId } })).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    const accountKey = 'c'.repeat(64);
    await expect(
      local.callback(id, 'wrong-token', { type: 'restore', accountKey })
    ).rejects.toThrow('本机连接凭据无效');
    await local.callback(id, launch.agentToken, { type: 'restore', accountKey });
    const document = {
      schema_version: 2,
      target_plan: 'plus',
      plan: 'chatgptplusplan',
      checkout_identifier: 'cs_fixture_original',
      processor_entity: 'fixture',
      payment_status: 'not_attempted'
    };
    await local.callback(id, launch.agentToken, {
      type: 'ledger',
      accountKey,
      fileKey: accountKey + '.json',
      revision: 0,
      document
    });
    await expect(
      local.callback(id, launch.agentToken, {
        type: 'ledger',
        accountKey,
        fileKey: accountKey + '.json',
        revision: 0,
        document
      })
    ).rejects.toThrow();
    await local.callback(id, launch.agentToken, {
      type: 'finished',
      result: { status: 'checkout_quote_verified' }
    });
    service = createService();
    local = createLocalService();
    const restoredId = randomUUID();
    const restored = await local.start({ ...input, id: restoredId }, operator);
    await expect(
      local.callback(restoredId, launch.agentToken, { type: 'restore', accountKey })
    ).rejects.toThrow('本机连接凭据无效');
    const result = await local.callback(restoredId, restored.agentToken, {
      type: 'restore',
      accountKey
    });
    expect(result).toMatchObject({ records: [{ revision: 1, document }] });
    const stored = await prisma.idBusinessV2RechargeJob.findMany({ where: { ownerId } });
    expect(JSON.stringify(stored)).not.toContain('fixture-private');
    expect(JSON.stringify(stored)).not.toContain(launch.agentToken);
    expect(JSON.stringify(stored)).not.toContain(restored.agentToken);
    await expect(
      local.callback(restoredId, restored.agentToken, {
        type: 'ledger',
        accountKey,
        fileKey: accountKey + '.json',
        revision: 1,
        document: { ...document, checkout_identifier: 'cs_different' }
      })
    ).rejects.toThrow('不可更换');
    await local.callback(restoredId, restored.agentToken, {
      type: 'finished',
      result: { status: 'payment_result_unknown' }
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
