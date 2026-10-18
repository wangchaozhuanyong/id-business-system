import { describe, expect, it, vi } from 'vitest';
import {
  authorizeExpiredCheckoutReplacement,
  consumeExpiredCheckoutMarker,
  expiredCheckoutProof,
  validateExpiredCheckoutMarker
} from './recharge-expired-checkout';
import { safeDocument, hash } from './recharge-validation';
import { RechargeService } from './recharge.service';
import { RechargeRepository } from './persistence/recharge.repository';
import { rechargeDocumentDigest } from './recharge-callback-receipts';
import { completeRechargeLedgerCallback } from './recharge-ledger-callback';

const accountKey = 'a'.repeat(64);
const checkout = 'oaics_synthetic_expired';
const fileKey = `${accountKey}.json`;
const proof = {
  checkout_identifier: checkout,
  processor_entity: 'openai_llc',
  target_plan: 'plus',
  account_key: accountKey,
  status: 'expired',
  payment_status: 'unpaid'
};

function fixture(identifier = checkout) {
  const original = {
    checkout_identifier: identifier,
    processor_entity: 'openai_llc',
    target_plan: 'plus',
    status: 'quote',
    payment_status: 'not_attempted',
    payment_attempted: false,
    payment_requests_sent: 0,
    confirmation_requests_sent: 0,
    card_tokenization_requests_sent: 0
  };
  const record = { accountKey, ownerId: 'owner', fileKey, revision: 5, document: original };
  const records = [record];
  const job = {
    id: '11111111-1111-4111-8111-111111111111',
    ownerId: 'owner',
    accountKey,
    action: 'bitbrowser',
    state: 'running',
    plan: 'plus',
    result: { ...original, mode: 'payment', account_matched: true, current_plan: 'free' } as Record<
      string,
      unknown
    >
  };
  const repository = {
    records: vi.fn(async () => records),
    createCycleArchive: vi.fn(async (_tx, _job, key, document) => {
      records.push({ accountKey, ownerId: 'owner', fileKey: key, revision: 1, document });
    }),
    updateJob: vi.fn(async (_tx, _id, data) => Object.assign(job, data))
  };
  const callback = {
    type: 'replace_expired_checkout',
    accountKey,
    checkoutIdentifier: identifier,
    proof: { ...proof, checkout_identifier: identifier }
  };
  const input = () => ({ tx: {} as never, job: job as never, repository: repository as never });
  const authorize = (value = callback) =>
    authorizeExpiredCheckoutReplacement({
      ...input(),
      callback: value,
      audit: { append: vi.fn() } as never
    });
  const marker = {
    status: 'checkout_attempted',
    stage: 'checkout_create',
    checkout_outcome: 'unknown',
    payment_status: 'not_attempted',
    payment_attempted: false,
    payment_requests_sent: 0,
    confirmation_requests_sent: 0,
    retry_of: 'b'.repeat(64),
    expired_checkout_replacement: callback.proof
  };
  const validate = (document = marker, revision = record.revision) =>
    validateExpiredCheckoutMarker({
      ...input(),
      callback: { accountKey, fileKey, revision },
      document
    });
  return { job, record, records, repository, callback, input, authorize, marker, validate };
}

function directReplacementFixture(
  kind: 'expired' | 'resolved' = 'expired',
  cycleOrigin?: Record<string, unknown>
) {
  const f = fixture();
  const agentToken = 'synthetic-replacement-agent-token';
  const job = {
    ...f.job,
    nonceHash: hash(agentToken),
    leaseUntil: new Date(Date.now() + 600000),
    createdAt: new Date(),
    result: {
      ...f.job.result,
      transport: 'web_direct',
      locked_currency: 'USD',
      quote: { synthetic: 'old-quote' },
      initial_quote: { synthetic: 'old-initial' },
      quote_digest: 'a'.repeat(64),
      quote_authority: 'official_checkout_response',
      billing_fingerprint: 'b'.repeat(64),
      quote_stage: 'final',
      final_quote_verified: true,
      checkout_status: 'created',
      checkout_link_available: true,
      checkout_recovered_from_original: true
    } as Record<string, unknown>
  };
  const prior =
    kind === 'resolved'
      ? {
          ...f.record.document,
          account_key: accountKey,
          operator_resolution: 'confirmed_verification_failed_no_charge',
          resolution_basis: 'operator_observed_official_failure',
          resolved_at: '2026-10-18T12:00:00Z',
          resolution_job_id: '44444444-4444-4444-8444-444444444444',
          source_job_id: '22222222-2222-4222-8222-222222222222',
          verification_job_id: '33333333-3333-4333-8333-333333333333'
        }
      : f.record.document;
  const original = { ...prior, ...(cycleOrigin ? { cycle_origin: cycleOrigin } : {}) };
  const records = new Map<
    string,
    { accountKey: string; ownerId: string; fileKey: string; revision: number; document: unknown }
  >([[fileKey, { ...f.record, document: original }]]);
  const tx = {
    idBusinessV2RechargeRecord: {
      findUnique: vi.fn(async ({ where }) => records.get(where.accountKey_fileKey.fileKey) ?? null),
      findMany: vi.fn(async () => [...records.values()]),
      create: vi.fn(async ({ data }) => {
        records.set(data.fileKey, data);
        return data;
      }),
      upsert: vi.fn(async ({ create, update }) => {
        const next = records.has(create.fileKey)
          ? { ...records.get(create.fileKey)!, ...update }
          : create;
        records.set(create.fileKey, next);
        return next;
      })
    }
  };
  const repository = new RechargeRepository({} as never);
  vi.spyOn(repository, 'lock').mockResolvedValue(undefined);
  vi.spyOn(repository, 'findJob').mockReturnValue(Promise.resolve(job) as never);
  vi.spyOn(repository, 'updateJob').mockImplementation(
    async (_tx, _id, data) => Object.assign(job, data) as never
  );
  const service = new RechargeService(
    repository,
    {} as never,
    { execute: async (work: (tx: object) => unknown) => work(tx) } as never,
    { append: vi.fn() } as never
  );
  const callback = (value: unknown) => service.callback(job.id, value, { localToken: agentToken });
  const marker = {
    ...(kind === 'expired' ? f.marker : {}),
    schema_version: 2,
    run_id: 'synthetic_replacement_run',
    created_at: 1700000000,
    status: 'checkout_attempted',
    stage: 'checkout_create',
    checkout_outcome: 'unknown',
    target_plan: 'plus',
    account_key: accountKey,
    account_matched: true,
    current_plan_before: 'free',
    plan: 'chatgptplusplan',
    transport: 'official_browser',
    payment_status: 'not_attempted',
    payment_attempted: false,
    payment_requests_sent: 0,
    confirmation_requests_sent: 0,
    retry_of: rechargeDocumentDigest(original)
  };
  const acceptMarker = async () => {
    if (kind === 'expired') await callback(f.callback);
    return callback({ type: 'ledger', accountKey, fileKey, revision: 5, document: marker });
  };
  const newDocument = () => ({
    ...marker,
    status: 'checkout_created',
    checkout_outcome: 'created',
    checkout_identifier: 'oaics_synthetic_new',
    processor_entity: 'openai_llc'
  });
  return { job, tx, repository, callback, records, marker, acceptMarker, newDocument, original };
}

describe('受控替换账本ACK后的当前订单绑定', () => {
  it.each(['expired', 'resolved'] as const)(
    '%s 绑定完整已落盘摘要并保留cycle_origin，客户端原始文档仍可接续新编号',
    async (kind) => {
      const cycleOrigin = {
        protocol: 1,
        job_id: '55555555-5555-4555-8555-555555555555',
        review_digest: 'd'.repeat(64)
      };
      const f = directReplacementFixture(kind, cycleOrigin);
      expect(f.marker).not.toHaveProperty('cycle_origin');
      expect(await f.acceptMarker()).toEqual({ revision: 6 });
      const stored = f.records.get(fileKey)!;
      expect(stored.document).toMatchObject({ cycle_origin: cycleOrigin });
      expect(f.job.result._checkout_replacement_binding_v1).toMatchObject({
        markerRevision: 6,
        markerDigest: rechargeDocumentDigest(stored.document)
      });
      expect(rechargeDocumentDigest(stored.document)).not.toBe(
        rechargeDocumentDigest(safeDocument(f.marker))
      );
      expect(
        await f.callback({ type: 'ledger', accountKey, fileKey, revision: 5, document: f.marker })
      ).toEqual({ revision: 6 });
      await expect(
        f.callback({
          type: 'ledger',
          accountKey,
          fileKey,
          revision: 6,
          document: { ...f.newDocument(), cycle_origin: { ...cycleOrigin, protocol: 2 } }
        })
      ).rejects.toThrow('不可写入的周期字段');
      expect(f.records.get(fileKey)!.revision).toBe(6);
      expect(
        await f.callback({
          type: 'ledger',
          accountKey,
          fileKey,
          revision: 6,
          document: f.newDocument()
        })
      ).toEqual({ revision: 7 });
      expect(f.job.result.checkout_identifier).toBe('oaics_synthetic_new');
      expect(f.job.result.transport).toBe('web_direct');
      expect(f.records.get(fileKey)!.document).toMatchObject({ cycle_origin: cycleOrigin });
      const money = { amount: '20.00', amount_minor: 2000, currency: 'USD' };
      const quote = {
        plan: 'plus',
        today: money,
        tax: { ...money, amount: '0.00', amount_minor: 0 },
        renewal: money,
        renewal_interval: 'monthly'
      };
      const quoted = {
        ...f.newDocument(),
        status: 'quote',
        stage: 'payment_confirmation',
        quote,
        quote_authority: 'official_checkout_response',
        billing_fingerprint: 'b'.repeat(64)
      };
      expect(
        await f.callback({ type: 'ledger', accountKey, fileKey, revision: 7, document: quoted })
      ).toEqual({ revision: 8 });
      expect(f.job.result.transport).toBe('web_direct');
      expect(f.records.get(fileKey)!.document).toMatchObject({
        transport: 'official_browser',
        cycle_origin: cycleOrigin,
        checkout_identifier: 'oaics_synthetic_new',
        quote
      });
      const finalReport = { ...quoted, transport: 'web_direct' };
      await f.callback({ type: 'direct_quote', result: finalReport });
      expect(f.job.state).toBe('awaiting_confirmation');
      expect(f.job.result).toMatchObject({
        transport: 'web_direct',
        payment_requests_sent: 0,
        confirmation_requests_sent: 0,
        checkout_identifier: 'oaics_synthetic_new',
        quote
      });
    }
  );
  it('账本完成回调首次和重放响应仅返回既有公开ACK字段', async () => {
    const f = directReplacementFixture('resolved');
    const input = () => ({
      tx: f.tx as never,
      job: f.job as never,
      callback: { type: 'ledger', accountKey, fileKey, revision: 5, document: f.marker },
      repository: f.repository,
      addressRepository: {} as never,
      audit: { append: vi.fn() } as never
    });
    expect(await completeRechargeLedgerCallback(input())).toEqual({ revision: 6 });
    const originalSave = f.repository.saveRecord.bind(f.repository);
    vi.spyOn(f.repository, 'saveRecord').mockImplementation(async (...args) => ({
      ...(await originalSave(...args)),
      checkoutMarkerDigest: 'e'.repeat(64),
      replacedVerificationCheckout: checkout
    }));
    expect(await completeRechargeLedgerCallback(input())).toEqual({ revision: 6, replayed: true });
  });
  it('服务端保留的周期元数据变化也使完整marker证明失效', async () => {
    const f = directReplacementFixture('resolved', { protocol: 1, review_digest: 'd'.repeat(64) });
    await f.acceptMarker();
    const stored = f.records.get(fileKey)!;
    stored.document = {
      ...(stored.document as Record<string, unknown>),
      cycle_origin: { protocol: 1, review_digest: 'f'.repeat(64) }
    };
    for (const callback of [
      { revision: 5, document: f.marker },
      { revision: 6, document: f.newDocument() }
    ])
      await expect(
        f.callback({ type: 'ledger', accountKey, fileKey, ...callback })
      ).rejects.toThrow();
    expect(f.job.result).not.toHaveProperty('checkout_identifier');
    expect(f.records.get(fileKey)!.revision).toBe(6);
  });
  it.each([
    { status: 'payment_result_unknown' },
    { payment_status: 'unknown' },
    { payment_record_write_failed: true },
    { card_tokenization_requests_sent: 1 }
  ])('客户端非付款状态不能解除已写入的当前绑定保护 %j', async (patch) => {
    const f = directReplacementFixture();
    await f.acceptMarker();
    await f.callback({
      type: 'progress',
      result: {
        payment_status: 'not_attempted',
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0,
        ...patch
      }
    });
    const previous = structuredClone(f.job.result);
    for (const identifier of [checkout, 'oaics_unpersisted'])
      await expect(
        f.callback({
          type: 'progress',
          result: {
            checkout_identifier: identifier,
            quote: { synthetic: 'old-quote' },
            payment_attempted: false,
            payment_requests_sent: 0,
            confirmation_requests_sent: 0
          }
        })
      ).rejects.toThrow('新结算尚未落盘');
    expect(f.job.result).toEqual(previous);
  });
  it.each([
    { recheck_only: true },
    { resolution_only: true },
    { transport: 'other' },
    { transport: 'official_browser' }
  ])('客户端不能改变有私有绑定任务的用途以跳过绑定保护 %j', async (patch) => {
    const f = directReplacementFixture();
    await f.acceptMarker();
    const before = structuredClone(f.job.result);
    await expect(f.callback({ type: 'progress', result: patch })).rejects.toThrow('用途');
    await expect(
      f.callback({
        type: 'progress',
        result: { checkout_identifier: checkout, quote: { synthetic: 'old-quote' } }
      })
    ).rejects.toThrow('新结算尚未落盘');
    expect(f.job.result).toEqual(before);
    Object.assign(f.job.result, patch);
    await expect(
      f.callback({ type: 'progress', result: { checkout_identifier: checkout } })
    ).rejects.toThrow('新结算尚未落盘');
  });
  it.each(['expired', 'resolved'] as const)(
    '%s 新建标记ACK清空当前绑定，HTTP400不会恢复旧单号或报价',
    async (kind) => {
      const f = directReplacementFixture(kind);
      expect(await f.acceptMarker()).toEqual({ revision: 6 });
      for (const key of [
        'checkout_identifier',
        'processor_entity',
        'quote',
        'initial_quote',
        'quote_digest',
        'quote_authority',
        'billing_fingerprint',
        'quote_stage',
        'final_quote_verified',
        'checkout_link_available',
        'checkout_recovered_from_original'
      ])
        expect(f.job.result).not.toHaveProperty(key);
      expect(f.job.result).toMatchObject({
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0,
        _checkout_replacement_binding_v1: {
          retiredIdentifier: checkout,
          markerRevision: 6,
          markerDigest: rechargeDocumentDigest(safeDocument(f.marker))
        }
      });
      const cleared = structuredClone(f.job.result);
      for (const patch of [
        { checkout_identifier: checkout },
        { processor_entity: 'openai_llc' },
        { quote: { plan: 'plus' } }
      ]) {
        await expect(
          f.callback({
            type: 'progress',
            result: {
              ...patch,
              stage: 'checkout_create',
              payment_attempted: false,
              payment_requests_sent: 0,
              confirmation_requests_sent: 0
            }
          })
        ).rejects.toThrow();
        expect(f.job.result).toEqual(cleared);
      }
      await f.callback({
        type: 'finished',
        result: {
          status: 'blocked',
          stage: 'checkout_create',
          reason: 'official_payment_form_load_failed',
          http_status: 400,
          checkout_requests_sent: 1,
          payment_attempted: false,
          payment_status: 'not_attempted',
          payment_requests_sent: 0,
          confirmation_requests_sent: 0
        }
      });
      expect(f.job.result).not.toHaveProperty('checkout_identifier');
      expect(f.job.result).not.toHaveProperty('quote');
      expect(f.job.result).toMatchObject({
        reason: 'official_payment_form_load_failed',
        http_status: 400,
        checkout_requests_sent: 1,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0
      });
      const archives = [...f.records.values()].filter((record) =>
        record.fileKey.startsWith('history/')
      );
      expect(archives).toHaveLength(1);
      expect(
        kind === 'expired'
          ? (archives[0]!.document as Record<string, unknown>).document
          : archives[0]!.document
      ).toEqual(f.original);
    }
  );
  it('只有匹配创建标记的checkout_created CAS落盘后才绑定新编号，旧回执仍不能覆盖', async () => {
    const f = directReplacementFixture();
    await f.acceptMarker();
    await expect(
      f.callback({
        type: 'progress',
        result: {
          checkout_identifier: 'oaics_synthetic_new',
          processor_entity: 'openai_llc',
          payment_attempted: false
        }
      })
    ).rejects.toThrow();
    const created = { type: 'ledger', accountKey, fileKey, revision: 6, document: f.newDocument() };
    expect(await f.callback(created)).toEqual({ revision: 7 });
    expect(f.job.result).toMatchObject({
      checkout_identifier: 'oaics_synthetic_new',
      processor_entity: 'openai_llc',
      checkout_status: 'created'
    });
    expect(await f.callback(created)).toEqual({ revision: 7 });
    for (const result of [
      { checkout_identifier: checkout },
      { checkout_identifier: 'oaics_unpersisted' },
      { processor_entity: 'other_processor' },
      { quote: { plan: 'plus' } },
      { payment_intent_identifier: 'pi_syntheticOld' },
      { checkout_status: 'created' }
    ])
      await expect(f.callback({ type: 'progress', result })).rejects.toThrow();
    await f.callback({
      type: 'progress',
      result: {
        checkout_identifier: 'oaics_synthetic_new',
        processor_entity: 'openai_llc',
        stage: 'payment_preparation',
        payment_attempted: false
      }
    });
    expect(f.job.result.checkout_identifier).toBe('oaics_synthetic_new');
  });
  it('新建标记或新建编号账本失败均不提前清除或绑定编号', async () => {
    const markerFailure = directReplacementFixture();
    markerFailure.tx.idBusinessV2RechargeRecord.upsert.mockRejectedValueOnce(
      new Error('synthetic-marker-write-failure')
    );
    await expect(markerFailure.acceptMarker()).rejects.toThrow('synthetic-marker-write-failure');
    expect(markerFailure.job.result.checkout_identifier).toBe(checkout);
    expect(markerFailure.job.result).not.toHaveProperty('_checkout_replacement_binding_v1');
    const createdFailure = directReplacementFixture();
    await createdFailure.acceptMarker();
    createdFailure.tx.idBusinessV2RechargeRecord.upsert.mockRejectedValueOnce(
      new Error('synthetic-created-write-failure')
    );
    await expect(
      createdFailure.callback({
        type: 'ledger',
        accountKey,
        fileKey,
        revision: 6,
        document: createdFailure.newDocument()
      })
    ).rejects.toThrow('synthetic-created-write-failure');
    expect(createdFailure.job.result).not.toHaveProperty('checkout_identifier');
    expect(createdFailure.records.get(fileKey)!.revision).toBe(6);
  });
  it.each(['expired', 'resolved'] as const)(
    '%s 新建标记ACK后只允许原版本重放，不能写第二份创建标记',
    async (kind) => {
      const f = directReplacementFixture(kind);
      await f.acceptMarker();
      const before = structuredClone(f.job.result);
      for (const document of [f.marker, { ...f.marker, run_id: 'second_attempt' }])
        await expect(
          f.callback({ type: 'ledger', accountKey, fileKey, revision: 6, document })
        ).rejects.toThrow();
      expect(f.records.get(fileKey)!.revision).toBe(6);
      expect(f.job.result).toEqual(before);
    }
  );
  it.each([
    { checkout_identifier: checkout },
    { account_key: 'b'.repeat(64) },
    { target_plan: 'go' },
    { run_id: 'another_run' },
    { quote: { plan: 'plus' } },
    { payment_requests_sent: 1 }
  ])('不接受不同原单、账号、套餐、marker或付款事实的新编号账本 %j', async (patch) => {
    const f = directReplacementFixture();
    await f.acceptMarker();
    await expect(
      f.callback({
        type: 'ledger',
        accountKey,
        fileKey,
        revision: 6,
        document: { ...f.newDocument(), ...patch }
      })
    ).rejects.toThrow();
    expect(f.job.result).not.toHaveProperty('checkout_identifier');
    expect(f.records.get(fileKey)!.revision).toBe(6);
  });
  it('客户端不能写入私有绑定指针，safeDocument也不会接收它', async () => {
    const f = directReplacementFixture();
    const forged = {
      _checkout_replacement_binding_v1: { retiredIdentifier: checkout, markerRevision: 6 }
    };
    expect(safeDocument(forged)).not.toHaveProperty('_checkout_replacement_binding_v1');
    await expect(f.callback({ type: 'progress', result: forged })).rejects.toThrow('内部字段');
    expect(f.job.result).not.toHaveProperty('_checkout_replacement_binding_v1');
  });
});

describe('官网已过期未付款原单的一次替换资格', () => {
  it('Stripe cs 原单同样先归档，再核验一次新建标记', async () => {
    const identifier = 'cs_live_synthetic_expired';
    const f = fixture(identifier);
    const grant = await f.authorize();
    expect(grant).toMatchObject({ replacementAuthorized: true, checkoutIdentifier: identifier });
    expect(f.repository.createCycleArchive).toHaveBeenCalledOnce();
    expect(f.record.document.checkout_identifier).toBe(identifier);
    await expect(f.validate({ ...f.marker, retry_of: grant.retryOf })).resolves.toBeDefined();
  });
  it.each(['cs_', 'cs_live_bad?secret=private', 'upg_synthetic', `cs_${'a'.repeat(181)}`])(
    '不接受无效 Stripe 原单编号：%s',
    (identifier) => {
      expect(() => expiredCheckoutProof({ ...proof, checkout_identifier: identifier })).toThrow();
    }
  );
  it('授权与新建标记之间出现付款事实或未知账本时，原资格立即失效', async () => {
    const changed = fixture();
    await changed.authorize();
    changed.job.result.payment_requests_sent = 1;
    await expect(changed.validate()).rejects.toThrow();
    const ledger = fixture();
    await ledger.authorize();
    ledger.records.push({
      ...ledger.record,
      fileKey: `payments/${'e'.repeat(64)}.json`,
      document: { ...ledger.record.document, payment_status: 'unknown', payment_attempted: true }
    });
    await expect(ledger.validate()).rejects.toThrow('新的付款记录');
  });

  it('实际回执链在同一事务先归档再CAS新建标记，重复标记仅回读且不得改写历史', async () => {
    const f = fixture();
    const agentToken = 'synthetic-expired-agent-token';
    const job = {
      ...f.job,
      nonceHash: hash(agentToken),
      leaseUntil: new Date(Date.now() + 600000),
      createdAt: new Date()
    };
    const records = new Map([[fileKey, f.record]]);
    const tx = {
      idBusinessV2RechargeJob: {
        findUnique: vi.fn(async () => job),
        findFirst: vi.fn(async () => null),
        update: vi.fn(async ({ data }) => Object.assign(job, data))
      },
      idBusinessV2RechargeRecord: {
        findUnique: vi.fn(
          async ({ where }) => records.get(where.accountKey_fileKey.fileKey) ?? null
        ),
        findMany: vi.fn(async () => [...records.values()]),
        create: vi.fn(async ({ data }) => {
          records.set(data.fileKey, data);
          return data;
        }),
        upsert: vi.fn(async ({ create, update }) => {
          const before = records.get(create.fileKey);
          const data = before ? { ...before, ...update } : create;
          records.set(create.fileKey, data);
          return data;
        })
      }
    };
    const repository = new RechargeRepository({} as never);
    vi.spyOn(repository, 'lock').mockResolvedValue(undefined);
    const service = new RechargeService(
      repository,
      {} as never,
      { execute: async (work: (tx: object) => Promise<unknown>) => work(tx) } as never,
      { append: vi.fn() } as never
    );
    const callback = (value: unknown) =>
      service.callback(job.id, value, { localToken: agentToken });
    await expect(callback(f.callback)).resolves.toMatchObject({
      replacementAuthorized: true,
      checkoutRecordRevision: 5
    });
    const archiveKey = [...records.keys()].find((key) => key.startsWith('history/'))!;
    const archive = structuredClone(records.get(archiveKey));
    const marker = { type: 'ledger', accountKey, fileKey, revision: 5, document: f.marker };
    await expect(callback(marker)).resolves.toEqual({ revision: 6 });
    expect(tx.idBusinessV2RechargeRecord.upsert).toHaveBeenCalledTimes(1);
    await expect(callback(marker)).resolves.toEqual({ revision: 6 });
    expect(tx.idBusinessV2RechargeRecord.upsert).toHaveBeenCalledTimes(1);
    expect(records.get(archiveKey)).toEqual(archive);
    await expect(
      callback({ ...marker, document: { ...f.marker, retry_of: 'c'.repeat(64) } })
    ).rejects.toThrow();
    expect(records.get(fileKey)!.revision).toBe(6);
  });

  it('精确绑定官网原单、账号、套餐且零付款，先不可变归档再返回创建资格', async () => {
    const f = fixture();
    await expect(f.authorize()).resolves.toMatchObject({
      ok: true,
      replacementAuthorized: true,
      checkoutIdentifier: checkout,
      checkoutRecordRevision: 5
    });
    expect(f.records[0]!.document).toEqual(f.record.document);
    expect(f.records[1]).toMatchObject({
      fileKey: expect.stringMatching(/^history\/[a-f0-9]{64}\.json$/),
      document: { kind: 'expired_checkout', document: f.record.document, proof }
    });
    expect(f.repository.createCycleArchive.mock.invocationCallOrder[0]).toBeLessThan(
      f.repository.updateJob.mock.invocationCallOrder[0]!
    );
    await expect(f.authorize()).resolves.toMatchObject({ replacementAuthorized: true });
    expect(f.repository.createCycleArchive).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 'open' },
    { payment_status: 'paid' },
    { account_key: 'f'.repeat(64) },
    { target_plan: 'go' },
    { checkout_identifier: 'oaics_other' }
  ])('拒绝不匹配官网证明 %j', async (change) => {
    const f = fixture();
    await expect(f.authorize({ ...f.callback, proof: { ...proof, ...change } })).rejects.toThrow();
    expect(f.repository.createCycleArchive).not.toHaveBeenCalled();
  });

  it.each([
    { recheck_only: true },
    { unidentified_checkout_recovery: true },
    { payment_attempted: true },
    { payment_requests_sent: 1 },
    { confirmation_requests_sent: 1 },
    { card_tokenization_requests_sent: 1 },
    { payment_requests_sent: '0' },
    { confirmation_requests_sent: false },
    { payment_attempted: 'false' },
    { manual_confirmation_accepted: true },
    { current_plan: 'plus' }
  ])('已有风险或只读模式不允许替换 %j', async (change) => {
    const f = fixture();
    Object.assign(f.job.result, change);
    await expect(f.authorize()).rejects.toThrow();
    expect(f.repository.createCycleArchive).not.toHaveBeenCalled();
  });

  it('未知付款记录存在时停止，归档失败也不给新建资格', async () => {
    const f = fixture();
    f.records.push({
      ...f.record,
      fileKey: `payments/${'c'.repeat(64)}.json`,
      document: { ...f.record.document, payment_attempted: true, payment_status: 'unknown' }
    });
    await expect(f.authorize()).rejects.toThrow('未安全结束');
    const failed = fixture();
    failed.repository.createCycleArchive.mockRejectedValueOnce(new Error('归档失败'));
    await expect(failed.authorize()).rejects.toThrow('归档失败');
    expect(failed.repository.updateJob).not.toHaveBeenCalled();
  });

  it('建单标记必须先取得同任务授权，并绑定原记录版本，使用后不能再授权', async () => {
    const f = fixture();
    await expect(f.validate()).rejects.toThrow();
    await f.authorize();
    await expect(f.validate()).resolves.toBe(true);
    await expect(f.validate(f.marker, 4)).rejects.toThrow();
    await consumeExpiredCheckoutMarker({ ...f.input(), document: f.marker });
    expect(f.job.result).not.toHaveProperty('checkout_identifier');
    await expect(f.authorize()).rejects.toThrow();
    await expect(f.validate({ ...f.marker, retry_of: 'd'.repeat(64) })).rejects.toThrow();
    // 完整的已消费相同标记只能交由revision幂等回执处理，不能生成另一份标记。
    await expect(f.validate()).resolves.toBe(true);
  });

  it('后续报价可继承官网过期证明，普通阶段不再次消费创建资格', async () => {
    const f = fixture();
    expect(safeDocument(f.marker).expired_checkout_replacement).toEqual(proof);
    await expect(f.validate({ ...f.marker, status: 'quote' })).resolves.toBe(false);
  });
});
