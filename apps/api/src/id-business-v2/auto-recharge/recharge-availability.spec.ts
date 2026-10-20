import { describe, expect, it, vi } from 'vitest';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import { rechargeAvailability } from './recharge-availability';
import { rechargeReviewQuery, reviewRechargeJobs } from './recharge-review';
import { RechargeRepository } from './persistence/recharge.repository';
import { hash } from './recharge-validation';
import { resolvedCyclePayment, safeUnpaidCycleCheckout } from './recharge-cycle-state';
import {
  resolvedDeclinedPayment,
  verificationFailureResolutionEligible
} from './recharge-noncharge-proof';
import { resolveDeclinedRecharge } from './recharge-declined-resolution';
import { unknownPaymentCanBeResolved, withResolutionVerification } from './recharge-resolution';
import { preserveRechargeResolutionMetadata } from './recharge-ledger-metadata';
import { presentRechargeJobs } from './recharge-job-list';
import { rechargeDocumentDigest } from './recharge-callback-receipts';
import { completeRechargeLedgerCallback } from './recharge-ledger-callback';

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

const verificationMarker = {
  ...marker,
  operator_resolution: 'confirmed_verification_failed_no_charge',
  resolution_basis: 'operator_observed_official_failure'
};

describe('web-direct verification-failure resolution proof', () => {
  const payment = {
    ...verificationMarker,
    payment_status: 'unknown',
    payment_attempted: true,
    payment_requests_sent: 1,
    confirmation_requests_sent: 1
  };
  it('resolves only complete server-audited unknown payment markers without rewriting facts', () => {
    expect(resolvedDeclinedPayment(payment)).toBe(true);
    expect(resolvedCyclePayment(payment)).toBe(true);
    expect(rechargeAvailability(job(payment), [], now)).toMatchObject({
      payment: 'resolved',
      accountPaymentRestricted: false
    });
    for (const patch of [
      { resolution_basis: undefined },
      { resolution_basis: 'arbitrary_observation' },
      { payment_requests_sent: 0 },
      { confirmation_requests_sent: 2 },
      { payment_status: 'requires_action' },
      { payment_status: 'paid' },
      { payment_evidence: { identifier: 'paid' } },
      { resolution_job_id: 'invalid' }
    ]) {
      expect(resolvedDeclinedPayment({ ...payment, ...patch })).toBe(false);
    }
    expect(
      safeUnpaidCycleCheckout({
        ...verificationMarker,
        checkout_identifier: 'cs_original',
        payment_status: 'not_attempted',
        payment_attempted: false,
        confirmation_requests_sent: 0
      })
    ).toBe(true);
    expect(payment.payment_status).toBe('unknown');
    expect(payment.confirmation_requests_sent).toBe(1);
    expect(unknownPaymentCanBeResolved(job(payment))).toBe(false);
    expect(withResolutionVerification({}, job(payment), [])).not.toHaveProperty(
      'resolution_verification_job_id'
    );
  });
  it('rejects client forgery or changes to the server-only resolution basis', () => {
    expect(() =>
      preserveRechargeResolutionMetadata(
        undefined,
        { resolution_basis: 'captured_official_failure' },
        false
      )
    ).toThrow();
    expect(() =>
      preserveRechargeResolutionMetadata(
        payment,
        { resolution_basis: 'captured_official_failure' },
        false
      )
    ).toThrow();
    expect(preserveRechargeResolutionMetadata(payment, {}, false)).toMatchObject(
      verificationMarker
    );
  });
});

describe('resolved original payment and readonly Go recheck history', () => {
  const recheckJob = (result: Record<string, unknown> = {}, overrides: object = {}) =>
    job(
      {
        transport: 'web_direct',
        recheck_only: true,
        source_job_id: id,
        checkout_identifier: 'cs_go_original',
        payment_attempted: true,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0,
        payment_status: 'unknown',
        ...result
      },
      { id: '44444444-4444-4444-8444-444444444444', plan: 'go', ...overrides }
    );
  const resolvedGoLedger = () => ({
    ownerId: 'owner',
    accountKey: key,
    fileKey: 'payments/' + hash('cs_go_original') + '.json',
    revision: 1,
    document: {
      ...verificationMarker,
      payment_status: 'unknown',
      payment_attempted: true,
      payment_requests_sent: 1,
      confirmation_requests_sent: 1,
      checkout_identifier: 'cs_go_original',
      account_key: key,
      target_plan: 'go'
    }
  });
  it('releases every finished same-source recheck by its resolved ledger without modifying historical results', () => {
    const records = [resolvedGoLedger()];
    const jobs = [
      job({ ...records[0]!.document }, { plan: 'go' }),
      recheckJob(),
      recheckJob({}, { id: '55555555-5555-4555-8555-555555555555' }),
      recheckJob({}, { id: '66666666-6666-4666-8666-666666666666' })
    ];
    const before = JSON.stringify(jobs);
    const presented = presentRechargeJobs(jobs, records as never, 'synthetic');
    expect(presented).toHaveLength(4);
    for (const item of presented)
      expect(item.availability).toMatchObject({
        payment: 'resolved',
        accountPaymentRestricted: false
      });
    expect(presented[1]!.result).toMatchObject({
      payment_status: 'unknown',
      payment_attempted: true,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0
    });
    expect(JSON.stringify(jobs)).toBe(before);
  });
  it.each([
    { source_job_id: '77777777-7777-4777-8777-777777777777' },
    { checkout_identifier: 'cs_another_original' },
    { source_job_id: '44444444-4444-4444-8444-444444444444' },
    { recheck_only: false },
    { payment_status: 'paid' },
    { payment_evidence: { identifier: 'paid' } },
    { payment_requests_sent: 1 },
    { confirmation_requests_sent: 1 },
    { operation: 'subscription_upgrade' },
    { transport: 'official_browser' }
  ])('does not release another source, checkout, payment or non-readonly task %j', (patch) => {
    expect(
      rechargeAvailability(recheckJob(patch), [resolvedGoLedger()], now).accountPaymentRestricted
    ).toBe(true);
  });
  it.each([
    { ownerId: 'other' },
    { accountKey: 'b'.repeat(64) },
    { fileKey: 'payments/' + 'f'.repeat(64) + '.json' },
    { document: { ...resolvedGoLedger().document, account_key: 'b'.repeat(64) } },
    {
      document: {
        ...resolvedGoLedger().document,
        source_job_id: '77777777-7777-4777-8777-777777777777'
      }
    },
    { document: { ...resolvedGoLedger().document, target_plan: 'plus' } },
    { document: { ...resolvedGoLedger().document, payment_evidence: { identifier: 'paid' } } },
    { document: { ...resolvedGoLedger().document, resolved_at: new Date(now - 1).toISOString() } }
  ])('requires unique matching owner, account, ledger file and original source %j', (patch) => {
    expect(
      rechargeAvailability(recheckJob(), [{ ...resolvedGoLedger(), ...patch }], now)
        .accountPaymentRestricted
    ).toBe(true);
  });
  it('does not use a resolved recheck to hide another unresolved original payment', () => {
    const other = {
      ...resolvedGoLedger(),
      fileKey: 'payments/' + hash('cs_another_original') + '.json',
      document: {
        account_key: key,
        checkout_identifier: 'cs_another_original',
        target_plan: 'go',
        payment_attempted: true,
        payment_requests_sent: 1,
        confirmation_requests_sent: 1,
        payment_status: 'unknown'
      }
    };
    expect(rechargeAvailability(recheckJob(), [resolvedGoLedger(), other], now)).toMatchObject({
      payment: 'resolved',
      accountPaymentRestricted: true
    });
    expect(
      rechargeAvailability(recheckJob({}, { state: 'running' }), [resolvedGoLedger()], now)
        .accountPaymentRestricted
    ).toBe(true);
    expect(
      rechargeAvailability(recheckJob(), [resolvedGoLedger(), resolvedGoLedger()], now)
        .accountPaymentRestricted
    ).toBe(true);
  });
});

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
  it('仅展示有效连接编号与名称，不泄漏接口指纹或密钥快照', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const item = job({
      connection_profile_id: id,
      connection_profile_name: 'Mac 子账号',
      connection_api_key: 'private-fingerprint',
      connection_snapshot_encrypted: 'private-snapshot'
    });
    const result = presentRechargeJobs([item], [], 'synthetic')[0]!;
    expect(result).toMatchObject({ connectionProfileId: id, connectionProfileName: 'Mac 子账号' });
    expect(JSON.stringify(result)).not.toContain('private-fingerprint');
    expect(JSON.stringify(result)).not.toContain('private-snapshot');
    expect(
      presentRechargeJobs(
        [job({ connection_profile_id: 'private-invalid-value' })],
        [],
        'synthetic'
      )[0]!.connectionProfileId
    ).toBeUndefined();
  });
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
  it.each([marker, verificationMarker])(
    'replacing a resolved checkout drops its release marker and preserves old payment facts %j',
    async (resolution) => {
      const before = {
        ...resolution,
        checkout_identifier: 'cs_original',
        target_plan: 'plus',
        payment_status: 'not_attempted',
        confirmation_requests_sent: 0
      };
      const existing = { ownerId: 'owner', accountKey: key, revision: 4, document: before };
      const tx = {
        idBusinessV2RechargeRecord: {
          findUnique: vi.fn().mockResolvedValue(existing),
          upsert: vi.fn(),
          create: vi.fn()
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
          retry_of:
            resolution.operator_resolution === 'confirmed_verification_failed_no_charge'
              ? rechargeDocumentDigest(before)
              : hash('cs_original')
        }
      };
      await expect(repository.saveRecord(tx as never, input)).rejects.toThrow();
      tx.idBusinessV2RechargeRecord.findUnique.mockImplementation(async ({ where }) =>
        where.accountKey_fileKey.fileKey.startsWith('history/') ? null : existing
      );
      await repository.saveRecord(tx as never, { ...input, allowResolvedDeclineReplacement: true });
      const stored = tx.idBusinessV2RechargeRecord.upsert.mock.calls[0]?.[0].update.document;
      expect(stored).not.toHaveProperty('operator_resolution');
      expect(stored).not.toHaveProperty('resolution_job_id');
      expect(stored).not.toHaveProperty('resolution_basis');
      expect(existing.document).toEqual(before);
      if (resolution.operator_resolution === 'confirmed_verification_failed_no_charge') {
        expect(tx.idBusinessV2RechargeRecord.create).toHaveBeenCalledWith({
          data: {
            accountKey: key,
            ownerId: 'owner',
            fileKey: `history/${rechargeDocumentDigest(before)}.json`,
            revision: 1,
            document: before
          }
        });
      } else expect(tx.idBusinessV2RechargeRecord.create).not.toHaveBeenCalled();
      expect(
        resolvedDeclinedPayment({
          ...marker,
          payment_status: 'unknown',
          payment_attempted: true,
          confirmation_requests_sent: 1
        })
      ).toBe(false);
    }
  );
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
  const observedFailure = {
    checkoutIdentifier: 'cs_original',
    officialMessage: 'payment_method_verification_failed'
  };
  const verificationFailureSource = {
    transport: 'web_direct',
    reason: 'unexpected_payment_observed',
    payment_status: 'unknown',
    _direct_unexpected_payment_v1: { observed: true, observedRequests: 1 }
  };
  it.each([
    ['captured_official_failure', 'official_payment_method_verification_failed', undefined],
    ['operator_observed_official_failure', 'unexpected_payment_observed', observedFailure]
  ] as const)(
    'records %s separately and preserves the source failure and payment history',
    async (basis, reason, observation) => {
      const f = fixture({ ...verificationFailureSource, reason });
      const before = structuredClone(f.source.result) as Record<string, unknown>;
      await resolveDeclinedRecharge(
        {} as never,
        f.repository as never,
        f.audit as never,
        id,
        {
          confirmNoDebit: true,
          verificationJobId: verificationId,
          ...(observation ? { verificationFailureObservation: observation } : {})
        },
        { id: 'owner' } as never
      );
      expect(f.repository.resolveUnknownPaymentRecords).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          kind: 'confirmed_verification_failed_no_charge',
          resolutionBasis: basis,
          checkoutIdentifier: 'cs_original'
        })
      );
      const stored = f.repository.updateJob.mock.calls[0]?.[2]?.result;
      expect(stored).toMatchObject({
        ...before,
        operator_resolution: 'confirmed_verification_failed_no_charge',
        resolution_basis: basis,
        reason,
        payment_status: 'unknown',
        payment_attempted: true,
        payment_requests_sent: 1,
        confirmation_requests_sent: 1
      });
      expect(f.source.result).toEqual(before);
      expect(f.audit.append).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          afterData: expect.objectContaining({
            bankNoDebitConfirmed: true,
            officialFailureCaptured: observation === undefined,
            operatorObservedOfficialFailure: observation !== undefined,
            resolutionBasis: basis,
            originalPaymentFactsPreserved: true
          })
        })
      );
      f.source.result = stored;
      const count = f.repository.updateJob.mock.calls.length;
      await expect(
        resolveDeclinedRecharge(
          {} as never,
          f.repository as never,
          f.audit as never,
          id,
          { confirmNoDebit: true, verificationJobId: verificationId },
          { id: 'owner' } as never
        )
      ).resolves.toMatchObject({ alreadyResolved: true });
      expect(f.repository.updateJob.mock.calls).toHaveLength(count);
    }
  );
  it.each([
    {},
    { verificationFailureObservation: { ...observedFailure, checkoutIdentifier: 'cs_other' } },
    { verificationFailureObservation: { ...observedFailure, officialMessage: 'card_declined' } },
    { verificationFailureObservation: { ...observedFailure, arbitrary: true } },
    { verificationFailureObservation: [] },
    { verificationFailureObservation: observedFailure, confirmNoDebit: false }
  ])(
    'does not resolve legacy unknown history without both explicit declarations %j',
    async (patch) => {
      const f = fixture(verificationFailureSource);
      await expect(
        resolveDeclinedRecharge(
          {} as never,
          f.repository as never,
          f.audit as never,
          id,
          { confirmNoDebit: true, verificationJobId: verificationId, ...patch },
          { id: 'owner' } as never
        )
      ).rejects.toThrow();
      expect(f.repository.resolveUnknownPaymentRecords).not.toHaveBeenCalled();
      expect(f.audit.append).not.toHaveBeenCalled();
    }
  );
  it.each([
    { transport: 'official_browser' },
    { payment_status: 'requires_action' },
    { payment_status: 'paid' },
    { payment_requests_sent: 2 },
    { confirmation_requests_sent: 0 },
    { confirmation_requests_sent: '1' },
    { payment_evidence: { identifier: 'paid' } },
    { operation: 'subscription_upgrade' },
    { recheck_only: true },
    { resolution_only: true },
    { status: 'subscription_activated' },
    { payment_outcome: 'subscription_activated' },
    { resolution_basis: 'operator_observed_official_failure' },
    { operator_resolution: 'conflicting_resolution' },
    { _direct_unexpected_payment_v1: { observed: true, observedRequests: 2 } },
    { _direct_unexpected_payment_v1: { observed: false, observedRequests: 2 } },
    { _direct_unexpected_payment_v1: { observed: true, observedRequests: '1' } },
    { _direct_unexpected_payment_v1: null }
  ])('keeps unsafe verification-failure sources locked %j', async (patch) => {
    const f = fixture({ ...verificationFailureSource, ...patch });
    expect(verificationFailureResolutionEligible(f.source)).toBe(false);
    await expect(
      resolveDeclinedRecharge(
        {} as never,
        f.repository as never,
        f.audit as never,
        id,
        {
          confirmNoDebit: true,
          verificationJobId: verificationId,
          verificationFailureObservation: observedFailure
        },
        { id: 'owner' } as never
      )
    ).rejects.toThrow();
    expect(f.repository.resolveUnknownPaymentRecords).not.toHaveBeenCalled();
  });
  it('requires an inactive owned source and a later non-recheck free-account verification', async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        f.source.state = 'running';
      },
      (f: ReturnType<typeof fixture>) => {
        f.source.ownerId = 'other';
      },
      (f: ReturnType<typeof fixture>) => {
        f.verification.ownerId = 'other';
      },
      (f: ReturnType<typeof fixture>) => {
        f.verification.accountKey = 'b'.repeat(64);
      },
      (f: ReturnType<typeof fixture>) => {
        f.verification.createdAt = new Date(now);
      },
      (f: ReturnType<typeof fixture>) => {
        f.verification.result = { ...(f.verification.result as object), recheck_only: true };
      },
      (f: ReturnType<typeof fixture>) => {
        f.verification.result = { ...(f.verification.result as object), payment_attempted: true };
      },
      (f: ReturnType<typeof fixture>) => {
        f.repository.findRunningJob.mockResolvedValue({ id } as never);
      }
    ]) {
      const f = fixture(verificationFailureSource);
      change(f);
      await expect(
        resolveDeclinedRecharge(
          {} as never,
          f.repository as never,
          f.audit as never,
          id,
          {
            confirmNoDebit: true,
            verificationJobId: verificationId,
            verificationFailureObservation: observedFailure
          },
          { id: 'owner' } as never
        )
      ).rejects.toThrow();
      expect(f.repository.resolveUnknownPaymentRecords).not.toHaveBeenCalled();
    }
  });
  it.each([
    ['unexpected_payment_observed', 'operator_observation_required'],
    ['official_payment_method_verification_failed', 'captured_official_failure']
  ])(
    'publishes a server-derived verification summary for %s only after qualifying verification',
    (reason, basis) => {
      const f = fixture({ ...verificationFailureSource, reason });
      expect(withResolutionVerification({}, f.source, [f.verification])).toMatchObject({
        payment_verification_resolution: {
          basis,
          checkoutIdentifier: 'cs_original',
          verificationJobId: verificationId,
          verifiedAt: new Date(now + 1).toISOString(),
          accountMatched: true,
          currentPlan: 'free'
        }
      });
      f.verification.result = { ...(f.verification.result as object), recheck_only: true };
      expect(withResolutionVerification({}, f.source, [f.verification])).not.toHaveProperty(
        'payment_verification_resolution'
      );
      f.verification.result = { account_matched: true, current_plan: 'free' };
      f.verification.createdAt = new Date(now);
      expect(withResolutionVerification({}, f.source, [f.verification])).not.toHaveProperty(
        'payment_verification_resolution'
      );
    }
  );
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
  it('the repository appends verification-failure audit facts without converting unknown into declined', async () => {
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
        reason: 'unexpected_payment_observed',
        payment_status: 'unknown',
        payment_attempted: true,
        payment_requests_sent: 1,
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
      kind: 'confirmed_verification_failed_no_charge' as const,
      resolutionBasis: 'operator_observed_official_failure' as const
    };
    const original = structuredClone(payment.document);
    await repository.resolveUnknownPaymentRecords(tx as never, input);
    expect(tx.idBusinessV2RechargeRecord.update).toHaveBeenCalledTimes(2);
    expect(tx.idBusinessV2RechargeRecord.update.mock.calls[1]?.[0].data.document).toMatchObject({
      ...original,
      operator_resolution: input.kind,
      resolution_basis: input.resolutionBasis
    });
    expect(payment.document).toEqual(original);
    tx.idBusinessV2RechargeRecord.update.mockClear();
    await expect(
      repository.resolveUnknownPaymentRecords(tx as never, { ...input, resolutionBasis: undefined })
    ).rejects.toThrow();
    for (const patch of [
      { payment_status: 'paid' },
      { payment_status: 'requires_action' },
      { confirmation_requests_sent: 2 },
      { payment_requests_sent: 0 },
      { operation: 'subscription_upgrade' },
      { payment_evidence: { identifier: 'paid' } },
      { resolution_job_id: '44444444-4444-4444-8444-444444444444' }
    ]) {
      payment.document = { ...original, ...patch } as typeof payment.document;
      await expect(repository.resolveUnknownPaymentRecords(tx as never, input)).rejects.toThrow();
    }
    payment.document = original;
    payment.ownerId = 'other';
    await expect(repository.resolveUnknownPaymentRecords(tx as never, input)).rejects.toThrow();
    payment.ownerId = 'owner';
    payment.fileKey = `payments/${hash('cs_other')}.json`;
    await expect(repository.resolveUnknownPaymentRecords(tx as never, input)).rejects.toThrow();
    expect(tx.idBusinessV2RechargeRecord.update).not.toHaveBeenCalled();
  });
});

describe('verification-failure same-plan checkout archive', () => {
  function fixture(officialTerminal = false) {
    const before = {
      ...verificationMarker,
      account_key: key,
      target_plan: 'plus',
      checkout_identifier: 'cs_original',
      payment_status: 'not_attempted',
      payment_attempted: false,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0,
      network: { country: 'PH', observedAt: '2026-10-15T09:00:00Z' },
      _retained_fixture: { nested: ['complete', 'original', 'document'] }
    };
    if (officialTerminal) {
      for (const key of [
        'operator_resolution',
        'resolution_basis',
        'resolved_at',
        'resolution_job_id',
        'source_job_id',
        'verification_job_id'
      ])
        delete (before as Record<string, unknown>)[key];
      (before as Record<string, unknown>)._official_terminal_failure_v1 = {
        kind: 'bound_payment_intent_declined',
        sourceJobId: id,
        accountKey: key,
        checkoutIdentifier: 'cs_original',
        paymentIntentIdentifier: 'pi_bound',
        plan: 'plus',
        confirmedAt: '2026-10-19T10:00:00.000Z'
      };
    }
    const archiveKey = `history/${rechargeDocumentDigest(before)}.json`;
    const root = {
      accountKey: key,
      ownerId: 'owner',
      fileKey: key + '.json',
      revision: 4,
      document: before
    };
    const entries = new Map<
      string,
      { accountKey: string; ownerId: string; fileKey: string; revision: number; document: unknown }
    >([[root.fileKey, root]]);
    const tx = {
      idBusinessV2RechargeRecord: {
        findUnique: vi.fn(
          async ({ where }) => entries.get(where.accountKey_fileKey.fileKey) ?? null
        ),
        create: vi.fn(async ({ data }) => {
          entries.set(data.fileKey, data);
          return data;
        }),
        upsert: vi.fn(async ({ where, create, update }) => {
          const next = entries.has(where.accountKey_fileKey.fileKey)
            ? { ...entries.get(where.accountKey_fileKey.fileKey)!, ...update }
            : create;
          entries.set(where.accountKey_fileKey.fileKey, next);
          return next;
        })
      }
    };
    const input = {
      ownerId: 'owner',
      accountKey: key,
      fileKey: root.fileKey,
      revision: 4,
      allowResolvedDeclineReplacement: true,
      document: {
        account_key: key,
        target_plan: 'plus',
        status: 'checkout_attempted',
        stage: 'checkout_create',
        checkout_outcome: 'unknown',
        payment_status: 'not_attempted',
        retry_of: rechargeDocumentDigest(before)
      }
    };
    return {
      before,
      archiveKey,
      root,
      entries,
      tx,
      input,
      repository: new RechargeRepository({} as never)
    };
  }
  it('archives the entire old checkout once and replays without touching old payment records', async () => {
    const f = fixture();
    const paymentFile = 'payments/' + hash('cs_original') + '.json';
    const payment = {
      accountKey: key,
      ownerId: 'owner',
      fileKey: paymentFile,
      revision: 2,
      document: {
        ...verificationMarker,
        payment_attempted: true,
        payment_status: 'unknown',
        payment_requests_sent: 1,
        confirmation_requests_sent: 1
      }
    };
    f.entries.set(paymentFile, payment);
    expect(await f.repository.saveRecord(f.tx as never, f.input)).toEqual({
      revision: 5,
      checkoutMarkerDigest: rechargeDocumentDigest(f.input.document),
      replacedVerificationCheckout: 'cs_original'
    });
    expect(f.entries.get(f.archiveKey)?.document).toEqual(f.before);
    expect(f.entries.get(paymentFile)).toEqual(payment);
    expect(f.entries.get(f.input.fileKey)?.document).not.toHaveProperty('operator_resolution');
    expect(await f.repository.saveRecord(f.tx as never, f.input)).toEqual({
      revision: 5,
      replayed: true
    });
    expect(f.tx.idBusinessV2RechargeRecord.create).toHaveBeenCalledOnce();
    expect(f.tx.idBusinessV2RechargeRecord.upsert).toHaveBeenCalledOnce();
  });
  it('官方intent终态同档新开走正常ledger CAS、完整归档并重置旧binding', async () => {
    const f = fixture(true);
    const fresh = job(
      {
        transport: 'web_direct',
        mode: 'payment',
        checkout_identifier: 'cs_original',
        payment_status: 'not_attempted',
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0
      },
      { state: 'running' }
    );
    vi.spyOn(f.repository, 'updateJob').mockImplementation(async (_tx, _id, data) =>
      Object.assign(fresh, data)
    );
    const response = await completeRechargeLedgerCallback({
      tx: f.tx as never,
      job: fresh,
      callback: {
        type: 'ledger',
        accountKey: key,
        fileKey: f.input.fileKey,
        revision: f.input.revision,
        document: f.input.document
      },
      repository: f.repository,
      addressRepository: {} as never,
      audit: { append: vi.fn() } as never
    });
    expect(response.revision).toBe(5);
    expect(f.entries.get(f.archiveKey)?.document).toEqual(f.before);
    expect(fresh.result).not.toHaveProperty('checkout_identifier');
    expect(fresh.result).toHaveProperty(
      '_checkout_replacement_binding_v1',
      expect.objectContaining({ retiredIdentifier: 'cs_original', markerRevision: 5 })
    );
    expect(f.entries.get(f.input.fileKey)?.document).not.toHaveProperty(
      '_official_terminal_failure_v1'
    );
  });
  it.each([
    { retry_of: 'b'.repeat(64) },
    { account_key: 'b'.repeat(64) },
    { target_plan: 'go' },
    { payment_requests_sent: 1 },
    { confirmation_requests_sent: 1 },
    { payment_attempted: true }
  ])('官方终态替换同样拒绝错误摘要/账号/套餐或付款痕迹 %j', async (patch) => {
    const f = fixture(true);
    await expect(
      f.repository.saveRecord(f.tx as never, {
        ...f.input,
        document: { ...f.input.document, ...patch }
      })
    ).rejects.toThrow();
    expect(f.tx.idBusinessV2RechargeRecord.upsert).not.toHaveBeenCalled();
    expect(f.tx.idBusinessV2RechargeRecord.create).not.toHaveBeenCalled();
  });
  it('reuses an existing identical complete archive without overwriting it', async () => {
    const f = fixture();
    const archive = { ...f.root, fileKey: f.archiveKey, revision: 1 };
    f.entries.set(f.archiveKey, archive);
    await f.repository.saveRecord(f.tx as never, f.input);
    expect(f.tx.idBusinessV2RechargeRecord.create).not.toHaveBeenCalled();
    expect(f.entries.get(f.archiveKey)).toEqual(archive);
  });
  it.each([
    { ownerId: 'other' },
    { accountKey: 'b'.repeat(64) },
    { document: { conflicting: true } }
  ])(
    'rejects conflicting archive ownership or content before replacing checkout %j',
    async (patch) => {
      const f = fixture();
      const archive = { ...f.root, fileKey: f.archiveKey, revision: 1, ...patch };
      f.entries.set(f.archiveKey, archive);
      await expect(f.repository.saveRecord(f.tx as never, f.input)).rejects.toThrow();
      expect(f.tx.idBusinessV2RechargeRecord.upsert).not.toHaveBeenCalled();
      expect(f.entries.get(f.input.fileKey)).toEqual(f.root);
      expect(f.entries.get(f.archiveKey)).toEqual(archive);
    }
  );
  it('does not overwrite any full original field even when the protocol digest excludes network timestamps', async () => {
    const f = fixture();
    const archived = {
      ...f.root,
      fileKey: f.archiveKey,
      document: {
        ...f.before,
        network: { ...f.before.network, observedAt: '2026-10-15T09:00:01Z' }
      }
    };
    expect(rechargeDocumentDigest(archived.document)).toBe(rechargeDocumentDigest(f.before));
    f.entries.set(f.archiveKey, archived);
    await expect(f.repository.saveRecord(f.tx as never, f.input)).rejects.toThrow();
    expect(f.tx.idBusinessV2RechargeRecord.upsert).not.toHaveBeenCalled();
    expect(f.entries.get(f.archiveKey)).toEqual(archived);
  });
  it('propagates archive failure and never replaces the original checkout first', async () => {
    const f = fixture();
    f.tx.idBusinessV2RechargeRecord.create.mockRejectedValue(
      new Error('synthetic-archive-failure')
    );
    await expect(f.repository.saveRecord(f.tx as never, f.input)).rejects.toThrow(
      'synthetic-archive-failure'
    );
    expect(f.tx.idBusinessV2RechargeRecord.upsert).not.toHaveBeenCalled();
    expect(f.entries.get(f.input.fileKey)).toEqual(f.root);
  });
  it.each([
    { retry_of: 'b'.repeat(64) },
    { target_plan: 'go' },
    { account_key: 'b'.repeat(64) },
    { payment_attempted: true },
    { payment_requests_sent: 1 },
    { confirmation_requests_sent: 1 }
  ])(
    'permits only the same original account, plan and zero-request checkout marker %j',
    async (patch) => {
      const f = fixture();
      await expect(
        f.repository.saveRecord(f.tx as never, {
          ...f.input,
          document: { ...f.input.document, ...patch }
        })
      ).rejects.toThrow();
      expect(f.tx.idBusinessV2RechargeRecord.create).not.toHaveBeenCalled();
      expect(f.tx.idBusinessV2RechargeRecord.upsert).not.toHaveBeenCalled();
    }
  );
});
