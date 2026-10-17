import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { RechargeService } from './recharge.service';
import { rechargeDocumentDigest } from './recharge-callback-receipts';
import { directRechargeAuthorized } from './recharge-direct-payment';
import { hash, object } from './recharge-validation';

// No generic DATABASE_URL fallback: opt-in and the isolated fixture URL are both required.
const enabled = process.env.RECHARGE_DIRECT_MYSQL_TEST === '1';
const fixtureUrl = process.env.V2_RECHARGE_TEST_DATABASE_URL;
const suite = enabled ? describe : describe.skip;

suite('网页直连付款真实MySQL事务与一次性授权', () => {
  let prisma: PrismaService | undefined;
  let repository: RechargeRepository;
  const ownerId = randomUUID();
  const taskIds = new Set<string>();
  const accountKeys = new Set<string>();
  const operator = {
    id: ownerId,
    username: 'direct-fixture-' + ownerId,
    displayName: '网页付款事务合成验收',
    roles: ['admin'],
    permissions: []
  };
  const quote = {
    plan: 'plus',
    today: { amount: '20.00', amount_minor: 2000, currency: 'USD' },
    tax: { amount: '0.00', amount_minor: 0, currency: 'USD' },
    renewal: { amount: '20.00', amount_minor: 2000, currency: 'USD' },
    renewal_interval: 'monthly'
  };
  const confirmAction = 'id_business_v2.auto_recharge.web_direct.confirm';
  const quoteAction = 'id_business_v2.auto_recharge.web_direct.quote_verified';
  const archiveAction = 'id_business_v2.auto_recharge.expired_checkout.authorize';
  const ledgerAction = 'id_business_v2.auto_recharge.ledger';
  const unexpectedAction = 'id_business_v2.auto_recharge.web_direct.unexpected_payment';

  const createService = (audit = new V2TransactionalAuditService()) =>
    new RechargeService(
      repository,
      new RechargeAddressRepository(prisma!),
      new V2CommandTransactionManager(prisma!),
      audit
    );
  const failingAudit = (action: string) => {
    const audit = new V2TransactionalAuditService();
    // The production write is awaited before injecting failure; the surrounding real tx must roll it back.
    return {
      append: async (...args: Parameters<V2TransactionalAuditService['append']>) => {
        const saved = await audit.append(...args);
        if (args[1].action === action) throw new Error('synthetic transactional audit failure');
        return saved;
      }
    } as unknown as V2TransactionalAuditService;
  };
  const audits = (id: string, action: string) =>
    prisma!.auditLog.count({ where: { userId: ownerId, objectId: id, action } });
  const records = (accountKey: string) =>
    prisma!.idBusinessV2RechargeRecord.findMany({
      where: { ownerId, accountKey },
      orderBy: { fileKey: 'asc' }
    });
  const archives = async (accountKey: string) =>
    (await records(accountKey)).filter((record) => record.fileKey.startsWith('history/'));

  const fixture = async () => {
    const id = randomUUID();
    const accountKey = hash('synthetic-direct-account-' + id);
    const checkout = 'oaics_synthetic_' + id.replaceAll('-', '');
    const fileKey = accountKey + '.json';
    const token = 'synthetic-direct-agent-' + id;
    const original = {
      schema_version: 2,
      target_plan: 'plus',
      checkout_identifier: checkout,
      processor_entity: 'openai_llc',
      status: 'quote',
      payment_status: 'not_attempted',
      payment_attempted: false,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0,
      card_tokenization_requests_sent: 0
    };
    const proof = {
      checkout_identifier: checkout,
      processor_entity: 'openai_llc',
      target_plan: 'plus',
      account_key: accountKey,
      status: 'expired',
      payment_status: 'unpaid'
    };
    taskIds.add(id);
    accountKeys.add(accountKey);
    await prisma!.idBusinessV2RechargeJob.create({
      data: {
        id,
        ownerId,
        accountKey,
        action: 'bitbrowser',
        state: 'running',
        plan: 'plus',
        nonceHash: hash(token),
        leaseUntil: new Date(Date.now() + 45 * 60000),
        result: {
          ...original,
          transport: 'web_direct',
          mode: 'payment',
          account_matched: true,
          current_plan: 'free',
          current_plan_before: 'free',
          locked_currency: 'USD'
        }
      }
    });
    await prisma!.idBusinessV2RechargeRecord.create({
      data: {
        ownerId,
        accountKey,
        fileKey,
        revision: 5,
        document: original
      }
    });
    const service = createService();
    const callback = (value: unknown, receiver = service) =>
      receiver.callback(id, value, { localToken: token });
    const report = {
      target_plan: 'plus',
      account_matched: true,
      current_plan_before: 'free',
      checkout_identifier: checkout,
      quote,
      quote_authority: 'official_checkout_response',
      billing_fingerprint: hash('synthetic-billing-' + id)
    };
    const prepare = async () => {
      const grant = object(await callback({ type: 'direct_quote', result: report }));
      return {
        nonce: String(grant.nonce),
        quoteDigest: String(grant.quote_digest),
        checkoutIdentifier: checkout
      };
    };
    const authorize = () =>
      callback({
        type: 'replace_expired_checkout',
        accountKey,
        checkoutIdentifier: checkout,
        proof
      });
    const marker = (grant: unknown) => ({
      type: 'ledger',
      accountKey,
      fileKey,
      revision: object(grant).checkoutRecordRevision,
      document: {
        schema_version: 2,
        run_id: randomUUID().replaceAll('-', ''),
        created_at: Math.floor(Date.now() / 1000),
        status: 'checkout_attempted',
        stage: 'checkout_create',
        target_plan: 'plus',
        account_matched: true,
        current_plan_before: 'free',
        checkout_outcome: 'unknown',
        payment_status: 'not_attempted',
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0,
        retry_of: object(grant).retryOf,
        expired_checkout_replacement: proof
      }
    });
    return {
      id,
      accountKey,
      checkout,
      fileKey,
      original,
      proof,
      service,
      callback,
      report,
      paymentFile: 'payments/' + hash(checkout) + '.json',
      prepare,
      authorize,
      marker
    };
  };

  beforeAll(async () => {
    if (!fixtureUrl) throw new Error('专用网页充值MySQL验收地址缺失');
    const parsed = new URL(fixtureUrl);
    if (
      parsed.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      !/^\/id_business_v2_recharge_direct_fixture(?:_[A-Za-z0-9_]+)?$/.test(parsed.pathname) ||
      parsed.search ||
      parsed.hash
    )
      throw new Error('网页付款事务验收仅允许显式指定本次回环隔离库');
    prisma = new PrismaService({ datasourceUrl: fixtureUrl });
    await prisma.$connect();
    repository = new RechargeRepository(prisma);
    await prisma.user.create({
      data: {
        id: ownerId,
        username: operator.username,
        displayName: operator.displayName,
        passwordHash: 'synthetic-not-a-valid-password'
      }
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    try {
      // Never truncate or clean by shared state: delete only this suite's exact synthetic IDs.
      if (taskIds.size) {
        await prisma.auditLog.deleteMany({
          where: { userId: ownerId, objectType: 'recharge_job', objectId: { in: [...taskIds] } }
        });
        await prisma.idBusinessV2RechargeJob.deleteMany({
          where: { ownerId, id: { in: [...taskIds] } }
        });
      }
      if (accountKeys.size)
        await prisma.idBusinessV2RechargeRecord.deleteMany({
          where: { ownerId, accountKey: { in: [...accountKeys] } }
        });
      await prisma.user.deleteMany({ where: { id: ownerId, username: operator.username } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('direct_quote不占付款记录，direct_confirm原子保留一次reserve和消费凭据', async () => {
    const f = await fixture();
    const request = await f.prepare();
    const prepared = await repository.byId(f.id);
    expect(prepared.state).toBe('awaiting_confirmation');
    expect(object(prepared.result)).toMatchObject({
      payment_attempted: false,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0,
      _direct_confirmation_v1: { consumed: false, nonceHash: hash(request.nonce) }
    });
    expect(JSON.stringify(prepared.result)).not.toContain(request.nonce);
    expect((await records(f.accountKey)).some((record) => record.fileKey === f.paymentFile)).toBe(
      false
    );
    await expect(f.service.confirm(f.id, request, operator)).resolves.toMatchObject({
      id: f.id,
      paymentAllowed: true,
      paymentRecordRevision: 1
    });
    const confirmed = await repository.byId(f.id);
    expect(confirmed.state).toBe('confirming');
    expect(object(confirmed.result)).toMatchObject({
      payment_attempted: true,
      payment_status: 'unknown',
      payment_requests_sent: 1,
      confirmation_requests_sent: 1,
      _direct_confirmation_v1: { consumed: true }
    });
    expect(directRechargeAuthorized(confirmed)).toBe(true);
    expect(
      (await records(f.accountKey)).filter((record) => record.fileKey === f.paymentFile)
    ).toMatchObject([
      {
        revision: 1,
        document: {
          checkout_identifier: f.checkout,
          quote_digest: request.quoteDigest,
          payment_status: 'unknown',
          payment_attempted: true,
          payment_requests_sent: 1,
          confirmation_requests_sent: 1
        }
      }
    ]);
    expect(await audits(f.id, quoteAction)).toBe(1);
    expect(await audits(f.id, confirmAction)).toBe(1);
  });

  it('并发重复确认只放行一次，重建服务后重放也不二放或改写reserve', async () => {
    const f = await fixture();
    const request = await f.prepare();
    const results = await Promise.allSettled([
      f.service.confirm(f.id, request, operator),
      createService().confirm(f.id, request, operator)
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const before = await repository.byId(f.id);
    const beforeRecords = await records(f.accountKey);
    await expect(createService().confirm(f.id, request, operator)).rejects.toThrow();
    expect(await repository.byId(f.id)).toEqual(before);
    expect(await records(f.accountKey)).toEqual(beforeRecords);
    expect(beforeRecords.filter((record) => record.fileKey === f.paymentFile)).toHaveLength(1);
    expect(await audits(f.id, confirmAction)).toBe(1);
  });

  it('confirm审计故障回滚reserve、任务消费及审计，原凭据仍只能成功一次', async () => {
    const f = await fixture();
    const request = await f.prepare();
    const before = await repository.byId(f.id);
    const beforeRecords = await records(f.accountKey);
    const faulty = createService(failingAudit(confirmAction));
    await expect(faulty.confirm(f.id, request, operator)).rejects.toThrow(
      'synthetic transactional audit failure'
    );
    expect(await repository.byId(f.id)).toEqual(before);
    expect(await records(f.accountKey)).toEqual(beforeRecords);
    expect(await audits(f.id, confirmAction)).toBe(0);
    await expect(f.service.confirm(f.id, request, operator)).resolves.toMatchObject({
      paymentAllowed: true
    });
    await expect(f.service.confirm(f.id, request, operator)).rejects.toThrow();
    expect(await audits(f.id, confirmAction)).toBe(1);
  });

  it('expired并发授权只有一份不可变归档，重复授权复用原revision和摘要', async () => {
    const f = await fixture();
    const before = await records(f.accountKey);
    const [first, second] = await Promise.all([f.authorize(), f.authorize()]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      replacementAuthorized: true,
      checkoutIdentifier: f.checkout,
      checkoutRecordRevision: 5,
      retryOf: rechargeDocumentDigest(f.original)
    });
    const history = await archives(f.accountKey);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      revision: 1,
      document: {
        kind: 'expired_checkout',
        source_job_id: f.id,
        source_file_key: f.fileKey,
        source_revision: 5,
        document: f.original,
        proof: f.proof
      }
    });
    await expect(f.authorize()).resolves.toEqual(first);
    expect(await archives(f.accountKey)).toEqual(history);
    expect((await records(f.accountKey)).find((record) => record.fileKey === f.fileKey)).toEqual(
      before[0]
    );
    expect(await audits(f.id, archiveAction)).toBe(1);
  });

  it('expired marker并发CAS只消费一次，精确重放不增版本，变更marker被拒绝', async () => {
    const f = await fixture();
    const marker = f.marker(await f.authorize());
    const history = await archives(f.accountKey);
    expect(await Promise.all([f.callback(marker), f.callback(marker)])).toEqual([
      { revision: 6 },
      { revision: 6 }
    ]);
    const consumed = await repository.byId(f.id);
    const currentRecords = await records(f.accountKey);
    expect(object(consumed.result)).toMatchObject({
      checkout_replacement_performed: true,
      _expired_checkout_replacement_v1: { consumed: true }
    });
    expect(object(consumed.result).checkout_identifier).toBeUndefined();
    await expect(
      f.callback({
        ...marker,
        document: { ...marker.document, run_id: randomUUID().replaceAll('-', '') }
      })
    ).rejects.toThrow();
    expect(await repository.byId(f.id)).toEqual(consumed);
    expect(await records(f.accountKey)).toEqual(currentRecords);
    expect(await archives(f.accountKey)).toEqual(history);
    expect(await audits(f.id, ledgerAction)).toBe(1);
  });

  it('expired授权后原记录revision变化，旧marker CAS拒绝且不消费授权', async () => {
    const f = await fixture();
    const marker = f.marker(await f.authorize());
    const history = await archives(f.accountKey);
    await f.callback({
      type: 'ledger',
      accountKey: f.accountKey,
      fileKey: f.fileKey,
      revision: 5,
      document: { ...f.original, reason: 'synthetic_changed_after_authorization' }
    });
    const before = await repository.byId(f.id);
    const beforeRecords = await records(f.accountKey);
    await expect(f.callback(marker)).rejects.toThrow();
    expect(await repository.byId(f.id)).toEqual(before);
    expect(object(before.result)._expired_checkout_replacement_v1).toMatchObject({
      consumed: false
    });
    expect(await records(f.accountKey)).toEqual(beforeRecords);
    expect(await archives(f.accountKey)).toEqual(history);
    expect(await audits(f.id, ledgerAction)).toBe(1);
  });

  it('expired marker审计故障时CAS与授权消费同事务回滚，归档保持原样', async () => {
    const f = await fixture();
    const marker = f.marker(await f.authorize());
    const before = await repository.byId(f.id);
    const beforeRecords = await records(f.accountKey);
    await expect(f.callback(marker, createService(failingAudit(ledgerAction)))).rejects.toThrow(
      'synthetic transactional audit failure'
    );
    expect(await repository.byId(f.id)).toEqual(before);
    expect(await records(f.accountKey)).toEqual(beforeRecords);
    expect(await audits(f.id, ledgerAction)).toBe(0);
    await expect(f.callback(marker)).resolves.toEqual({ revision: 6 });
    expect(await archives(f.accountKey)).toEqual(
      beforeRecords.filter((record) => record.fileKey.startsWith('history/'))
    );
    expect(await audits(f.id, ledgerAction)).toBe(1);
  });

  it('unexpected未知付款负向锁拒绝原确认与换单，不生成许可且重放不清零', async () => {
    const f = await fixture();
    const request = await f.prepare();
    const input = {
      type: 'direct_unexpected_payment',
      result: {
        checkout_identifier: f.checkout,
        processor_entity: 'openai_llc',
        target_plan: 'plus',
        account_matched: true,
        current_plan_before: 'free',
        payment_requests_sent: 1,
        confirmation_requests_sent: 1
      }
    };
    await expect(f.callback(input)).resolves.toEqual({ ok: true, paymentLocked: true });
    const locked = await repository.byId(f.id);
    const lockedRecords = await records(f.accountKey);
    expect(directRechargeAuthorized(locked)).toBe(false);
    expect(object(locked.result)).toMatchObject({
      payment_attempted: true,
      payment_status: 'unknown',
      payment_requests_sent: 1,
      confirmation_requests_sent: 1,
      _direct_confirmation_v1: { consumed: false },
      _direct_unexpected_payment_v1: { observed: true }
    });
    expect(lockedRecords.find((record) => record.fileKey === f.paymentFile)).toMatchObject({
      revision: 1,
      document: {
        checkout_identifier: f.checkout,
        payment_attempted: true,
        payment_status: 'unknown',
        payment_requests_sent: 1,
        confirmation_requests_sent: 1
      }
    });
    await expect(f.service.confirm(f.id, request, operator)).rejects.toThrow();
    await expect(f.authorize()).rejects.toThrow();
    await expect(f.callback({ type: 'direct_quote', result: f.report })).rejects.toThrow();
    await expect(f.callback(input)).resolves.toEqual({ ok: true, paymentLocked: true });
    expect(await repository.byId(f.id)).toEqual(locked);
    expect(await records(f.accountKey)).toEqual(lockedRecords);
    expect(await archives(f.accountKey)).toHaveLength(0);
    expect(await audits(f.id, unexpectedAction)).toBe(1);
    expect(await audits(f.id, confirmAction)).toBe(0);
  });
});
