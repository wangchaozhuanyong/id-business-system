import { describe, expect, it, vi } from 'vitest';
import { RechargeService } from './recharge.service';
import { RechargeRepository } from './persistence/recharge.repository';
import { hash } from './recharge-validation';

const id = '11111111-1111-4111-8111-111111111111';
const accountKey = 'a'.repeat(64);
const quote = {
  plan: 'plus',
  today: { amount: '20.00', amount_minor: 2000, currency: 'USD' },
  tax: { amount: '0.00', amount_minor: 0, currency: 'USD' },
  renewal: { amount: '20.00', amount_minor: 2000, currency: 'USD' },
  source: null,
  tax_status: null,
  renewal_interval: 'monthly'
};

function fixture(upgrade: boolean) {
  const identifier = upgrade ? `upg_${'b'.repeat(32)}` : 'oaics_recheck_original';
  const binding: Record<string, unknown> = upgrade
    ? {
        operation: 'subscription_upgrade',
        upgrade_identifier: identifier,
        upgrade_invoice_identifier: 'in_SyntheticRecheck',
        current_plan_before: 'go',
        quote_authority: 'official_upgrade_preview'
      }
    : {
        checkout_identifier: identifier,
        processor_entity: 'openai_llc',
        current_plan_before: 'free',
        quote_authority: 'official_checkout_response'
      };
  const job = {
    id,
    ownerId: 'owner',
    accountKey,
    plan: 'plus',
    action: 'bitbrowser',
    state: 'running',
    nonceHash: hash('synthetic-recheck-token'),
    createdAt: new Date(),
    leaseUntil: new Date(Date.now() + 600000),
    result: {
      ...binding,
      quote,
      transport: 'web_direct',
      mode: 'recheck',
      recheck_only: true,
      account_matched: true,
      target_plan: 'plus',
      payment_attempted: true,
      payment_status: 'unknown',
      payment_requests_sent: 0,
      confirmation_requests_sent: 0
    } as Record<string, unknown>
  };
  const fileKey = `payments/${hash(identifier)}.json`;
  let record = {
    accountKey,
    ownerId: job.ownerId,
    fileKey,
    revision: 4,
    document: {
      ...binding,
      quote,
      quote_digest: 'c'.repeat(64),
      account_key: accountKey,
      target_plan: 'plus',
      created_at: 1700000000,
      payment_attempted: true,
      payment_status: 'unknown',
      payment_requests_sent: 1,
      confirmation_requests_sent: 1
    } as Record<string, unknown>
  };
  const tx = {
    idBusinessV2RechargeRecord: {
      findUnique: vi.fn(async () => record),
      upsert: vi.fn(async ({ update }) => {
        record = { ...record, ...update };
        return record;
      })
    }
  };
  const persistence = new RechargeRepository({} as never);
  const repository = {
    lock: vi.fn(),
    findJob: vi.fn(async () => job),
    records: vi.fn(async () => [record]),
    saveRecord: vi.fn(persistence.saveRecord.bind(persistence)),
    updateJob: vi.fn(async (_tx, _id, data) => Object.assign(job, data))
  };
  const audit = { append: vi.fn() };
  const service = new RechargeService(
    repository as never,
    {} as never,
    { execute: async (work: (tx: object) => unknown) => work(tx) } as never,
    audit as never
  );
  const paid = {
    status: 'subscription_activated',
    stage: 'original_payment_recheck',
    account_matched: true,
    current_plan: 'plus',
    payment_status: 'paid',
    payment_outcome: 'subscription_activated',
    subscription_status: 'plus',
    payment_evidence: {
      kind: upgrade ? 'invoice' : 'checkout_session',
      identifier: upgrade ? 'in_SyntheticRecheck' : identifier,
      amount_minor: 2000,
      currency: 'USD'
    }
  };
  const callback = (body: object) =>
    service.callback(id, body, { localToken: 'synthetic-recheck-token' });
  return { job, tx, repository, paid, callback, fileKey, getRecord: () => record };
}

describe('网页只读复查写回原付款账本', () => {
  it.each([false, true])(
    '既有unknown经CAS更新paid，原付款计数1、复查任务两计数0：upgrade=%s',
    async (upgrade) => {
      const f = fixture(upgrade);
      const original = f.getRecord();
      const body = {
        type: 'ledger',
        accountKey,
        fileKey: f.fileKey,
        revision: original.revision,
        document: { ...original.document, ...f.paid }
      };
      await expect(f.callback(body)).resolves.toEqual({ revision: 5 });
      expect(f.getRecord()).toMatchObject({
        revision: 5,
        document: {
          payment_status: 'paid',
          payment_attempted: true,
          payment_requests_sent: 1,
          confirmation_requests_sent: 1,
          quote: original.document.quote,
          quote_digest: original.document.quote_digest,
          payment_evidence: f.paid.payment_evidence,
          created_at: original.document.created_at
        }
      });
      expect(f.getRecord().document.recheck_only).toBeUndefined();
      expect(f.job.result).toMatchObject({
        recheck_only: true,
        payment_status: 'paid',
        payment_requests_sent: 0,
        confirmation_requests_sent: 0
      });
      await expect(f.callback(body)).resolves.toEqual({ revision: 5 });
      expect(f.tx.idBusinessV2RechargeRecord.upsert).toHaveBeenCalledOnce();
      await f.callback({
        type: 'finished',
        result: {
          ...f.job.result,
          ...f.paid,
          payment_attempted: true,
          payment_requests_sent: 0,
          confirmation_requests_sent: 0
        }
      });
      expect(f.job).toMatchObject({
        state: 'finished',
        result: { payment_status: 'paid', payment_requests_sent: 0, confirmation_requests_sent: 0 }
      });
      expect(f.getRecord().document).toMatchObject({
        payment_status: 'paid',
        payment_requests_sent: 1,
        confirmation_requests_sent: 1
      });
    }
  );

  it('原版本或报价变化时拒绝CAS写回，不虚报账本成功', async () => {
    const f = fixture(false);
    const original = f.getRecord();
    await expect(
      f.callback({
        type: 'ledger',
        accountKey,
        fileKey: f.fileKey,
        revision: original.revision - 1,
        document: { ...original.document, ...f.paid }
      })
    ).rejects.toThrow('版本冲突');
    await expect(
      f.callback({
        type: 'ledger',
        accountKey,
        fileKey: f.fileKey,
        revision: original.revision,
        document: { ...original.document, ...f.paid, quote_digest: 'd'.repeat(64) }
      })
    ).rejects.toThrow('不能回退或变更报价');
    expect(f.getRecord().document.payment_status).toBe('unknown');
    expect(f.tx.idBusinessV2RechargeRecord.upsert).not.toHaveBeenCalled();
    expect(f.job.result).toMatchObject({
      payment_status: 'unknown',
      payment_requests_sent: 0,
      confirmation_requests_sent: 0
    });
  });
});
