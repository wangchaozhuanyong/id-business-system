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
