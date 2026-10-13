import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { RechargeService } from './recharge.service';
import { RechargeLocalService } from './recharge-local.service';
import { cyclePaidDocument } from './recharge-cycle-test-fixture';
import { hash, object } from './recharge-validation';
import { readCycleState } from './recharge-cycle-state';
import { rechargeDocumentDigest } from './recharge-callback-receipts';

const url = process.env.V2_RECHARGE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('下一订阅周期真实MySQL唯一消费与事务回滚', () => {
  let prisma: PrismaService;
  let repository: RechargeRepository;
  const create = (audit = new V2TransactionalAuditService()) => {
    const transactions = new V2CommandTransactionManager(prisma);
    const service = new RechargeService(repository, {} as never, transactions, audit);
    return new RechargeLocalService(
      repository,
      {} as never,
      {} as never,
      service,
      transactions,
      audit
    );
  };
  const fixture = async () => {
    const ownerId = randomUUID();
    await prisma.user.create({
      data: {
        id: ownerId,
        username: 'cycle-' + ownerId,
        displayName: '周期合成验收',
        passwordHash: 'synthetic-not-valid-password'
      }
    });
    const id = randomUUID(),
      accountKey = hash(randomUUID()),
      token = 'synthetic-cycle-' + randomUUID();
    const old = cyclePaidDocument(accountKey, 'cs_' + randomUUID().replaceAll('-', ''));
    const oldSourceId = randomUUID();
    await prisma.idBusinessV2RechargeJob.create({
      data: {
        id: oldSourceId,
        ownerId,
        accountKey,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'finished',
        leaseUntil: new Date(Date.now() - 86400000),
        result: toV2JsonDocument(old)
      }
    });
    await prisma.idBusinessV2RechargeRecord.createMany({
      data: [
        {
          accountKey,
          ownerId,
          fileKey: accountKey + '.json',
          revision: 2,
          document: toV2JsonDocument(old)
        },
        {
          accountKey,
          ownerId,
          fileKey: 'payments/' + hash(String(old.checkout_identifier)) + '.json',
          revision: 3,
          document: toV2JsonDocument(old)
        }
      ]
    });
    await prisma.idBusinessV2RechargeJob.create({
      data: {
        id,
        ownerId,
        accountKey,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'running',
        nonceHash: hash(token),
        leaseUntil: new Date(Date.now() + 45 * 60000),
        result: {
          mode: 'payment',
          client_cycle_protocol: 1,
          payment_attempted: false,
          payment_requests_sent: 0
        }
      }
    });
    const local = create();
    const inspection = () => ({
      source: 'official_account_response',
      account_key: accountKey,
      account_matched: true,
      current_plan: 'free',
      has_active_subscription: false,
      checked_at: new Date().toISOString()
    });
    const prepare = (phase: string, patch: object = {}, receiver = local) =>
      receiver.callback(id, token, {
        type: 'prepare_next_subscription_cycle',
        subscriptionCycleProtocol: 1,
        accountKey,
        phase,
        ...patch
      });
    const inspect = () =>
      prepare('inspect', {
        subscription_inspection: {
          ...inspection(),
          checked_at: new Date(Date.now() - 100).toISOString()
        }
      });
    const commit = async (receiver = local) => {
      const job = await repository.byId(id);
      return prepare(
        'commit',
        {
          reviewDigest: readCycleState(job)!.review.reviewDigest,
          subscription_inspection: inspection()
        },
        receiver
      );
    };
    const marker = async () => {
      const grant = readCycleState(await repository.byId(id))!.grant!;
      return {
        type: 'ledger',
        accountKey,
        fileKey: grant.checkoutFileKey,
        revision: grant.checkoutRevision,
        document: {
          status: 'checkout_attempted',
          stage: 'checkout_create',
          run_id: 'a'.repeat(32),
          target_plan: 'plus',
          checkout_outcome: 'unknown',
          payment_status: 'not_attempted',
          account_matched: true,
          current_plan_before: 'free',
          next_cycle_grant: {
            protocol: 1,
            jobId: id,
            accountKey,
            targetPlan: 'plus',
            reviewDigest: grant.reviewDigest
          }
        }
      };
    };
    return { id, accountKey, token, old, oldSourceId, local, inspect, commit, marker };
  };
  const unpaidRestoreFixture = async () => {
    const ownerId = randomUUID(),
      accountKey = hash(randomUUID()),
      id = randomUUID(),
      sourceId = randomUUID(),
      token = 'synthetic-restore-' + randomUUID();
    await prisma.user.create({
      data: {
        id: ownerId,
        username: 'restore-' + ownerId,
        displayName: '恢复原单合成验收',
        passwordHash: 'synthetic-not-valid-password'
      }
    });
    const source = {
      status: 'blocked',
      reason: 'browser_operation_failed',
      stage: 'session_restore',
      account_matched: false,
      checkout_identifier: 'cs_old_' + sourceId.replaceAll('-', ''),
      checkout_requests_sent: 0,
      payment_status: 'not_attempted',
      payment_attempted: false,
      payment_requests_sent: 0
    };
    const document = {
      status: 'cancelled',
      checkout_identifier: 'cs_current_' + id.replaceAll('-', ''),
      target_plan: 'plus',
      checkout_outcome: 'cancelled',
      cancelled_before_confirmation: true,
      payment_status: 'not_attempted',
      payment_attempted: false,
      confirmation_requests_sent: 0,
      payment_requests_sent: 0
    };
    await prisma.idBusinessV2RechargeJob.create({
      data: {
        id: sourceId,
        ownerId,
        accountKey,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'finished',
        leaseUntil: new Date(Date.now() - 1000),
        result: source
      }
    });
    await prisma.idBusinessV2RechargeRecord.create({
      data: { ownerId, accountKey, fileKey: accountKey + '.json', revision: 16, document }
    });
    await prisma.idBusinessV2RechargeJob.create({
      data: {
        id,
        ownerId,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'running',
        nonceHash: hash(token),
        leaseUntil: new Date(Date.now() + 45 * 60000),
        result: {
          status: 'waiting_local_connector',
          stage: 'connector_dispatch',
          manual_payment_confirmation: true,
          payment_requests_sent: 0
        }
      }
    });
    const restore = () => create().callback(id, token, { type: 'restore', accountKey });
    return { id, ownerId, accountKey, sourceId, document, restore };
  };
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== '127.0.0.1' ||
      !/^\/id_business_v2_employee_connections_flow_\d+$/.test(parsed.pathname)
    )
      throw new Error('周期测试只允许连接本次自有空隔离库');
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
    repository = new RechargeRepository(prisma);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('并发恢复与重放绑定当前安全取消原单，旧引用和账本版本保持原样', async () => {
    const f = await unpaidRestoreFixture();
    const source = await repository.byId(f.sourceId);
    const records = await repository.records(prisma as never, f.accountKey);
    const results = await Promise.all([f.restore(), f.restore()]);
    expect(
      results.every(
        (result) => object(result).originalCheckoutIdentifier === f.document.checkout_identifier
      )
    ).toBe(true);
    expect((await repository.byId(f.id)).result).toMatchObject({
      checkout_identifier: f.document.checkout_identifier,
      payment_requests_sent: 0
    });
    expect(await repository.byId(f.sourceId)).toEqual(source);
    expect(await repository.records(prisma as never, f.accountKey)).toEqual(records);
  });

  it('历史原单含未知付款时恢复拒绝且事务回滚，不能只凭当前根零付款覆盖历史', async () => {
    const f = await unpaidRestoreFixture();
    const source = await repository.byId(f.sourceId);
    await prisma.idBusinessV2RechargeJob.update({
      where: { id: f.sourceId },
      data: {
        result: toV2JsonDocument({
          ...object(source.result),
          payment_attempted: true,
          confirmation_requests_sent: 1,
          payment_status: 'unknown'
        })
      }
    });
    const before = await repository.byId(f.id);
    const records = await repository.records(prisma as never, f.accountKey);
    await expect(f.restore()).rejects.toThrow('历史付款状态未核实');
    expect(await repository.byId(f.id)).toEqual(before);
    expect(await repository.records(prisma as never, f.accountKey)).toEqual(records);
  });

  it('并发commit与首marker只归档一次、消费一次；重放保持相同原单和paid证据', async () => {
    const f = await fixture();
    await f.inspect();
    const lease = (await repository.byId(f.id)).leaseUntil;
    const commits = await Promise.all([f.commit(), f.commit()]);
    expect(commits.every((result) => object(result).nextCycleContext)).toBe(true);
    const archives = await prisma.idBusinessV2RechargeRecord.findMany({
      where: { accountKey: f.accountKey, fileKey: { startsWith: 'history/' } }
    });
    expect(archives).toHaveLength(1);
    expect(archives[0]!.document).toEqual(f.old);
    expect(archives[0]!.fileKey).toHaveLength(77);
    expect((await repository.byId(f.id)).leaseUntil).toEqual(lease);
    const receipt = await f.marker();
    const results = await Promise.all([
      f.local.callback(f.id, f.token, receipt),
      f.local.callback(f.id, f.token, receipt)
    ]);
    expect(results).toContainEqual({ revision: 4 });
    expect(results).toContainEqual({ revision: 4, replayed: true });
    expect(readCycleState(await repository.byId(f.id))?.grant?.status).toBe('consumed');
    const payment = await prisma.idBusinessV2RechargeRecord.findUnique({
      where: {
        accountKey_fileKey: {
          accountKey: f.accountKey,
          fileKey: 'payments/' + hash(String(f.old.checkout_identifier)) + '.json'
        }
      }
    });
    expect(payment!.document).toMatchObject({
      payment_status: 'paid',
      payment_attempted: true,
      confirmation_requests_sent: 1,
      payment_evidence: f.old.payment_evidence,
      cycle_resolution: { status: 'closed' }
    });
    const newRecord = await prisma.idBusinessV2RechargeRecord.findUnique({
      where: { accountKey_fileKey: { accountKey: f.accountKey, fileKey: f.accountKey + '.json' } }
    });
    expect(newRecord!.document).toMatchObject({
      status: 'checkout_attempted',
      checkout_outcome: 'unknown',
      cycle_origin: { job_id: f.id }
    });
    expect(
      await prisma.auditLog.count({
        where: { objectId: f.id, action: 'id_business_v2.auto_recharge.subscription_cycle.consume' }
      })
    ).toBe(1);
    const differing = structuredClone(receipt);
    differing.document.run_id = 'b'.repeat(32);
    await expect(f.local.callback(f.id, f.token, differing)).rejects.toThrow('只能恢复');
    expect(readCycleState(await repository.byId(f.id))?.markerRevision).toBe(4);
  });

  it('commit归档或marker写入后审计失败整体回滚，不给第二资格、不损坏旧paid', async () => {
    const f = await fixture();
    await f.inspect();
    const before = await prisma.idBusinessV2RechargeRecord.findMany({
      where: { accountKey: f.accountKey },
      orderBy: { fileKey: 'asc' }
    });
    const audit = new V2TransactionalAuditService();
    const append = audit.append.bind(audit);
    audit.append = (async (
      tx: Parameters<typeof append>[0],
      input: Parameters<typeof append>[1]
    ) => {
      await append(tx, input);
      if (input.action === 'id_business_v2.auto_recharge.subscription_cycle.commit')
        throw new Error('synthetic cycle rollback');
    }) as unknown as typeof audit.append;
    await expect(f.commit(create(audit))).rejects.toThrow('synthetic cycle rollback');
    expect(
      await prisma.idBusinessV2RechargeRecord.findMany({
        where: { accountKey: f.accountKey },
        orderBy: { fileKey: 'asc' }
      })
    ).toEqual(before);
    expect(readCycleState(await repository.byId(f.id))?.grant).toBeUndefined();
    await f.commit();
    const receipt = await f.marker();
    const auditConsume = new V2TransactionalAuditService();
    auditConsume.append = (async () => {
      throw new Error('synthetic marker rollback');
    }) as unknown as typeof auditConsume.append;
    await expect(create(auditConsume).callback(f.id, f.token, receipt)).rejects.toThrow(
      'synthetic marker rollback'
    );
    expect(readCycleState(await repository.byId(f.id))?.grant?.status).toBe('granted');
    const closed = await prisma.idBusinessV2RechargeRecord.findUnique({
      where: { accountKey_fileKey: { accountKey: f.accountKey, fileKey: f.accountKey + '.json' } }
    });
    expect(closed!.document).toHaveProperty('cycle_resolution');
    expect(closed!.revision).toBe(3);
    expect(await f.local.callback(f.id, f.token, receipt)).toEqual({ revision: 4 });
  });

  it('commit后重启与过期恢复保留同conversion，首marker后只能回读未知原操作', async () => {
    const f = await fixture();
    await f.inspect();
    await f.commit();
    const job = await repository.byId(f.id),
      state = readCycleState(job)!;
    const oldDigest = state.review.reviewDigest;
    const expired = new Date(Date.now() - 1000).toISOString();
    await prisma.idBusinessV2RechargeJob.update({
      where: { id: f.id },
      data: {
        result: toV2JsonDocument({
          ...object(job.result),
          _subscription_cycle_private_v1: {
            ...state,
            inspection: {
              ...state.inspection,
              checked_at: new Date(Date.now() - 600000).toISOString()
            },
            review: { ...state.review, expiresAt: expired },
            grant: { ...state.grant, expiresAt: expired }
          }
        })
      }
    });
    const restarted = create();
    await restarted.callback(f.id, f.token, {
      type: 'prepare_next_subscription_cycle',
      subscriptionCycleProtocol: 1,
      accountKey: f.accountKey,
      phase: 'inspect',
      subscription_inspection: {
        source: 'official_account_response',
        account_key: f.accountKey,
        account_matched: true,
        current_plan: 'free',
        has_active_subscription: false,
        checked_at: new Date().toISOString()
      }
    });
    expect(readCycleState(await repository.byId(f.id))?.grant?.reviewDigest).toBe(oldDigest);
    expect(
      await prisma.idBusinessV2RechargeRecord.count({
        where: { accountKey: f.accountKey, fileKey: { startsWith: 'history/' } }
      })
    ).toBe(1);
    const receipt = await f.marker();
    await restarted.callback(f.id, f.token, receipt);
    const restored = await create().callback(f.id, f.token, {
      type: 'restore',
      accountKey: f.accountKey,
      subscriptionCycleProtocol: 1
    });
    expect(restored).toHaveProperty('nextCycleContext.grant.status', 'consumed');
    const record = await prisma.idBusinessV2RechargeRecord.findUnique({
      where: { accountKey_fileKey: { accountKey: f.accountKey, fileKey: f.accountKey + '.json' } }
    });
    expect(rechargeDocumentDigest(record!.document)).toBe(
      rechargeDocumentDigest({
        ...receipt.document,
        next_cycle_grant: undefined,
        cycle_origin: object(record!.document).cycle_origin
      })
    );
  });
});
