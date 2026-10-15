import { describe, expect, it, vi } from 'vitest';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import { rechargeAvailability } from './recharge-availability';
import { rechargeReviewQuery, reviewRechargeJobs } from './recharge-review';
import { RechargeRepository } from './persistence/recharge.repository';
import { hash } from './recharge-validation';
import { resolvedCyclePayment, safeUnpaidCycleCheckout } from './recharge-cycle-state';
import { resolvedDeclinedPayment } from './recharge-noncharge-proof';
import { resolveDeclinedRecharge } from './recharge-declined-resolution';

const id = '11111111-1111-4111-8111-111111111111';
const verificationId = '22222222-2222-4222-8222-222222222222';
const key = 'a'.repeat(64);
const now = Date.parse('2026-10-15T10:00:00Z');
const job = (result: Record<string, unknown> = {}, overrides: object = {}) =>
  ({
    id,
    ownerId: 'owner',
    cardId: null,
    chatgptAccountId: null,
    proxyId: null,
    billingNameEncrypted: null,
    expectedEmailEncrypted: null,
    accountKey: key,
    plan: 'plus',
    action: 'bitbrowser',
    state: 'finished',
    result: { payment_attempted: false, payment_requests_sent: 0, ...result },
    createdAt: new Date(now - 1000),
    updatedAt: new Date(now),
    leaseUntil: new Date(now + 1000),
    nonceHash: 'private-fixture',
    ...overrides
  }) as IdBusinessV2RechargeJob;
const marker = {
  operator_resolution: 'confirmed_declined_no_charge',
  resolved_at: '2026-10-15T10:00:00Z',
  resolution_job_id: '33333333-3333-4333-8333-333333333333',
  source_job_id: id,
  verification_job_id: verificationId
};

describe('execution occupancy and account payment protection', () => {
  it('releases failed zero-request tasks without clearing another historical payment', () => {
    const source = job({ status: 'blocked', reason: 'proxy_unavailable' });
    const record = {
      ownerId: 'owner',
      accountKey: key,
      fileKey: 'payments/' + hash('cs_old') + '.json',
      revision: 1,
      document: {
        account_key: key,
        payment_attempted: true,
        confirmation_requests_sent: 1,
        payment_status: 'requires_action'
      }
    };
    const value = rechargeAvailability(source, [record], now);
    expect(value).toMatchObject({
      execution: 'released',
      payment: 'no_request',
      accountPaymentRestricted: true
    });
    expect(
      rechargeAvailability(source, [{ ...record, accountKey: 'b'.repeat(64) }], now)
        .accountPaymentRestricted
    ).toBe(false);
    expect(
      rechargeAvailability(source, [{ ...record, ownerId: 'other' }], now).accountPaymentRestricted
    ).toBe(false);
  });
  it('expiry frees execution only and never proves an attempted payment failed', () => {
    expect(
      rechargeAvailability(
        job(
          { payment_attempted: true, payment_status: 'unknown' },
          { state: 'running', leaseUntil: new Date(now - 1) }
        ),
        [],
        now
      )
    ).toMatchObject({ execution: 'expired', payment: 'unknown', accountPaymentRestricted: true });
    expect(
      rechargeAvailability(job({}, { state: 'running', leaseUntil: new Date(now - 1) }), [], now)
    ).toMatchObject({
      execution: 'expired',
      payment: 'no_request',
      accountPaymentRestricted: false
    });
    expect(rechargeAvailability(job({}, { state: 'running' }), [], now).execution).toBe('active');
  });
  it.each(['unknown', 'requires_action', 'paid'])(
    'keeps %s without complete evidence restricted',
    (status) => {
      expect(
        rechargeAvailability(job({ payment_status: status }), [], now).accountPaymentRestricted
      ).toBe(true);
    }
  );
  it('never presents an invalid paid evidence object as a completed subscription', () => {
    expect(
      rechargeAvailability(
        job({
          payment_status: 'paid',
          payment_evidence: { identifier: 'unbound' },
          status: 'subscription_activated'
        }),
        [],
        now
      )
    ).toMatchObject({ payment: 'unknown', accountPaymentRestricted: true });
  });
  it('does not infer declined resolution from timeout, free status or a bare marker', () => {
    for (const result of [
      { payment_status: 'declined' },
      { payment_status: 'declined', current_plan: 'free' },
      { payment_status: 'declined', operator_resolution: marker.operator_resolution }
    ]) {
      expect(rechargeAvailability(job(result), [], now)).toMatchObject({
        payment: 'declined',
        accountPaymentRestricted: true
      });
    }
  });
  it('accepts a complete audited declined resolution and preserves original attempts', () => {
    const payment = {
      ...marker,
      payment_status: 'declined',
      payment_attempted: true,
      confirmation_requests_sent: 1
    };
    expect(resolvedCyclePayment(payment)).toBe(true);
    expect(rechargeAvailability(job(payment), [], now)).toMatchObject({
      payment: 'resolved',
      accountPaymentRestricted: false
    });
    expect(
      safeUnpaidCycleCheckout({
        ...marker,
        payment_status: 'not_attempted',
        checkout_identifier: 'cs_old',
        confirmation_requests_sent: 0
      })
    ).toBe(true);
    expect(resolvedDeclinedPayment({ ...payment, payment_status: 'unknown' })).toBe(false);
    expect(resolvedCyclePayment({ ...payment, payment_evidence: { identifier: 'paid' } })).toBe(
      false
    );
  });
});

describe('paginated read-only review', () => {
  it.each([{ page: 0 }, { pageSize: 101 }, { page: 1.1 }, { search: 'x'.repeat(101) }])(
    'rejects invalid bounds %o',
    (query) => {
      expect(() => rechargeReviewQuery(query)).toThrow();
    }
  );
  it('scopes both pagination and supplemental records to the authenticated owner; no writes', async () => {
    const item = job({ connection_api_key: 'must-not-return', _private: 'must-not-return' });
    const repository = {
      reviewPage: vi.fn().mockResolvedValue({ items: [item], total: 42 }),
      paymentRecords: vi.fn().mockResolvedValue([]),
      verificationCandidates: vi.fn().mockResolvedValue([])
    };
    const before = JSON.stringify(item);
    const result = await reviewRechargeJobs(
      repository as never,
      'owner',
      { page: '2', pageSize: '20', search: 'fixture' },
      ''
    );
    expect(repository.reviewPage).toHaveBeenCalledWith('owner', {
      page: 2,
      pageSize: 20,
      search: 'fixture'
    });
    expect(repository.paymentRecords).toHaveBeenCalledWith('owner', [key], true);
    expect(repository.verificationCandidates).toHaveBeenCalledWith('owner', [key]);
    expect(result).toMatchObject({ total: 42, page: 2, pageSize: 20 });
    expect(JSON.stringify(result)).not.toContain('must-not-return');
    expect(result.items[0]?.nonceHash).toBeUndefined();
    expect(result.items[0]?.accountKey).toBeUndefined();
    expect(JSON.stringify(item)).toBe(before);
  });
});

describe('declined-only resolution', () => {
  it('replacing a resolved declined checkout drops the old release marker and keeps old payment facts', async () => {
    const before = {
      ...marker,
      checkout_identifier: 'cs_original',
      target_plan: 'plus',
      payment_status: 'not_attempted',
      confirmation_requests_sent: 0
    };
    const existing = { ownerId: 'owner', accountKey: key, revision: 4, document: before };
    const tx = {
      idBusinessV2RechargeRecord: {
        findUnique: vi.fn().mockResolvedValue(existing),
        upsert: vi.fn()
      }
    };
    const repository = new RechargeRepository({} as never);
    const input = {
      ownerId: 'owner',
      accountKey: key,
      fileKey: key + '.json',
      revision: 4,
      document: {
        account_key: key,
        target_plan: 'plus',
        status: 'checkout_attempted',
        stage: 'checkout_create',
        checkout_outcome: 'unknown',
        payment_status: 'not_attempted',
        retry_of: 'b'.repeat(64)
      }
    };
    await expect(repository.saveRecord(tx as never, input)).rejects.toThrow();
    await repository.saveRecord(tx as never, { ...input, allowResolvedDeclineReplacement: true });
    const stored = tx.idBusinessV2RechargeRecord.upsert.mock.calls[0]?.[0].update.document;
    expect(stored).not.toHaveProperty('operator_resolution');
    expect(stored).not.toHaveProperty('resolution_job_id');
    expect(existing.document).toEqual(before);
    expect(
      resolvedDeclinedPayment({
        ...marker,
        payment_status: 'unknown',
        payment_attempted: true,
        confirmation_requests_sent: 1
      })
    ).toBe(false);
  });
  function fixture(result: Record<string, unknown> = {}) {
    const source = job({
      payment_attempted: true,
      payment_requests_sent: 1,
      confirmation_requests_sent: 1,
      payment_status: 'declined',
      checkout_identifier: 'cs_original',
      ...result
    });
    const verification = job(
      {
        mode: 'open_browser',
        account_matched: true,
        current_plan: 'free',
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0
      },
      { id: verificationId, createdAt: new Date(now + 1) }
    );
    const repository = {
      lock: vi.fn(),
      findJob: vi.fn(async (_: unknown, id: string) => (id === source.id ? source : verification)),
      findRunningJob: vi.fn().mockResolvedValue(null),
      resolveUnknownPaymentRecords: vi.fn(),
      createJob: vi.fn(),
      updateJob: vi.fn()
    };
    return { source, verification, repository, audit: { append: vi.fn() } };
  }
  it.each(['unknown', 'requires_action', 'paid'])(
    'rejects %s before any mutation',
    async (status) => {
      const f = fixture({ payment_status: status });
      await expect(
        resolveDeclinedRecharge(
          {} as never,
          f.repository as never,
          f.audit as never,
          id,
          { confirmNoDebit: true, verificationJobId: verificationId },
          { id: 'owner' } as never
        )
      ).rejects.toThrow();
      expect(f.repository.resolveUnknownPaymentRecords).not.toHaveBeenCalled();
      expect(f.audit.append).not.toHaveBeenCalled();
    }
  );
  it('requires explicit bank confirmation and later same-account free verification', async () => {
    const f = fixture();
    await expect(
      resolveDeclinedRecharge(
        {} as never,
        f.repository as never,
        f.audit as never,
        id,
        { confirmNoDebit: false, verificationJobId: verificationId },
        { id: 'owner' } as never
      )
    ).rejects.toThrow();
    f.verification.accountKey = 'b'.repeat(64);
    await expect(
      resolveDeclinedRecharge(
        {} as never,
        f.repository as never,
        f.audit as never,
        id,
        { confirmNoDebit: true, verificationJobId: verificationId },
        { id: 'owner' } as never
      )
    ).rejects.toThrow();
    expect(f.repository.createJob).not.toHaveBeenCalled();
  });
  it('does not accept a free-account snapshot taken before the final payment result', async () => {
    const f = fixture();
    f.verification.createdAt = new Date(now - 500);
    await expect(
      resolveDeclinedRecharge(
        {} as never,
        f.repository as never,
        f.audit as never,
        id,
        { confirmNoDebit: true, verificationJobId: verificationId },
        { id: 'owner' } as never
      )
    ).rejects.toThrow();
    expect(f.repository.resolveUnknownPaymentRecords).not.toHaveBeenCalled();
  });
  it('records a finished resolution and an audit without resetting source payment counters', async () => {
    const f = fixture();
    await resolveDeclinedRecharge(
      {} as never,
      f.repository as never,
      f.audit as never,
      id,
      { confirmNoDebit: true, verificationJobId: verificationId },
      { id: 'owner' } as never
    );
    expect(f.repository.resolveUnknownPaymentRecords).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        kind: 'confirmed_declined_no_charge',
        ownerId: 'owner',
        checkoutIdentifier: 'cs_original'
      })
    );
    expect(f.repository.updateJob).toHaveBeenCalledWith(
      {},
      id,
      expect.objectContaining({
        result: expect.objectContaining({
          payment_attempted: true,
          confirmation_requests_sent: 1,
          payment_requests_sent: 1,
          payment_status: 'declined'
        })
      })
    );
    expect(f.repository.createJob).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ state: 'finished' })
    );
    expect(f.audit.append).toHaveBeenCalledOnce();
  });
  it('the real repository refuses unknown/paid/foreign or already conflicting payment documents', async () => {
    const repository = new RechargeRepository({} as never);
    const checkout = {
      accountKey: key,
      ownerId: 'owner',
      revision: 1,
      fileKey: key + '.json',
      document: {
        checkout_identifier: 'cs_original',
        target_plan: 'plus',
        payment_status: 'not_attempted',
        confirmation_requests_sent: 0
      }
    };
    const payment = {
      ...checkout,
      fileKey: 'payments/' + hash('cs_original') + '.json',
      document: {
        account_key: key,
        checkout_identifier: 'cs_original',
        target_plan: 'plus',
        payment_status: 'unknown',
        payment_attempted: true,
        confirmation_requests_sent: 1
      }
    };
    vi.spyOn(repository, 'records').mockResolvedValue([checkout, payment] as never);
    const tx = { idBusinessV2RechargeRecord: { update: vi.fn() } };
    const input = {
      accountKey: key,
      checkoutIdentifier: 'cs_original',
      plan: 'plus',
      ownerId: 'owner',
      resolutionJobId: marker.resolution_job_id,
      sourceJobId: id,
      verificationJobId: verificationId,
      resolvedAt: marker.resolved_at,
      kind: 'confirmed_declined_no_charge' as const
    };
    await expect(repository.resolveUnknownPaymentRecords(tx as never, input)).rejects.toThrow();
    expect(tx.idBusinessV2RechargeRecord.update).not.toHaveBeenCalled();
    payment.document.payment_status = 'declined';
    await repository.resolveUnknownPaymentRecords(tx as never, input);
    expect(tx.idBusinessV2RechargeRecord.update).toHaveBeenCalledTimes(2);
    expect(tx.idBusinessV2RechargeRecord.update.mock.calls[1]?.[0].data.document).toMatchObject({
      payment_status: 'declined',
      payment_attempted: true,
      confirmation_requests_sent: 1
    });
  });
});
