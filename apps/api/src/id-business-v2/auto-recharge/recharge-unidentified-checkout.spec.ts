import { describe, expect, it, vi } from 'vitest';
import { restoreRechargeAccount } from './recharge-account-restore';
import { findOriginalRechargeCheckout } from './recharge-job-helpers';
import { RechargeRepository } from './persistence/recharge.repository';
import {
  findUnidentifiedCheckoutSource,
  isUnidentifiedUnpaidCheckout
} from './recharge-unidentified-checkout';
import { safeDocument } from './recharge-validation';

const accountKey = 'a'.repeat(64);
const sourceId = '11111111-1111-4111-8111-111111111111';
const profileId = 'b'.repeat(32);
const document = () => ({
  status: 'blocked',
  reason: 'checkout_unknown_write',
  stage: 'checkout_create',
  account_matched: true,
  payment_status: 'not_attempted',
  payment_attempted: false,
  checkout_requests_sent: 1,
  payment_requests_sent: 0,
  confirmation_requests_sent: 0,
  browser_profile_id: profileId,
  target_plan: 'plus',
  plan: 'chatgptplusplan'
});
const source = () => ({
  id: sourceId,
  ownerId: 'owner',
  accountKey,
  action: 'bitbrowser',
  state: 'finished',
  plan: 'plus',
  result: document()
});

function fixture() {
  const actual = new RechargeRepository({} as never);
  const previous = source();
  const records: {
    ownerId: string;
    fileKey: string;
    revision: number;
    document: Record<string, unknown>;
  }[] = [{ ownerId: 'owner', fileKey: `${accountKey}.json`, revision: 2, document: document() }];
  const tx = { idBusinessV2RechargeJob: { findMany: vi.fn().mockResolvedValue([previous]) } };
  const repository = {
    records: vi.fn().mockResolvedValue(records),
    retainedProfileForAccount: vi
      .fn()
      .mockResolvedValue({ sourceJobId: sourceId, profileId, accountKey }),
    findJob: vi.fn().mockResolvedValue(previous),
    finishedJobsForUnidentifiedCheckout: vi.fn().mockResolvedValue([previous]),
    updateJob: vi.fn(),
    restoreCheckoutIdentifier: actual.restoreCheckoutIdentifier,
    originalCheckoutForAccount: actual.originalCheckoutForAccount
  };
  const job = {
    id: '22222222-2222-4222-8222-222222222222',
    ownerId: 'owner',
    accountKey,
    action: 'bitbrowser',
    state: 'running',
    plan: 'plus',
    result: {
      mode: 'payment',
      payment_requests_sent: 0,
      checkout_requests_sent: 0
    }
  };
  const input = { tx, job, callback: { accountKey }, repository };
  return { input, previous, records, tx, repository };
}

describe('unidentified original checkout discovery', () => {
  it('keeps an unidentified attempt blocked from creation unless the exact original source qualifies', () => {
    const repo = new RechargeRepository({} as never);
    const { records } = fixture();
    expect(() => repo.restoreCheckoutIdentifier(records, accountKey, 'plus', [])).toThrow('未核实');
    expect(repo.restoreCheckoutIdentifier(records, accountKey, 'plus', [], true)).toBeUndefined();
    expect(() =>
      repo.restoreCheckoutIdentifier(records, accountKey, 'plus', ['oaics_other'], true)
    ).toThrow();
  });
  it('authorizes original-window discovery without inventing a checkout identifier', async () => {
    const { input, repository } = fixture();
    const result = await restoreRechargeAccount(input as never);
    expect(result.unidentifiedCheckoutRecovery).toBe(true);
    expect(result.originalCheckoutIdentifier).toBeUndefined();
    expect(result.ownedProfile?.profileId).toBe(profileId);
    expect(repository.updateJob).toHaveBeenCalledOnce();
  });
  it('preserves exact unidentified discovery when another expired checkout is archived', async () => {
    const { input, previous, records, repository } = fixture();
    const expired = 'oaics_expired_before_unidentified';
    records.push({
      ownerId: 'owner',
      fileKey: `history/${'c'.repeat(64)}.json`,
      revision: 1,
      document: {
        kind: 'expired_checkout',
        document: { checkout_identifier: expired, payment_status: 'not_attempted' },
        proof: {
          account_key: accountKey,
          target_plan: 'plus',
          checkout_identifier: expired,
          status: 'expired',
          payment_status: 'unpaid'
        }
      }
    });
    input.tx.idBusinessV2RechargeJob.findMany.mockResolvedValue([
      {
        ...previous,
        id: '33333333-3333-4333-8333-333333333333',
        result: { ...document(), checkout_identifier: expired }
      },
      previous
    ] as never);
    const result = await restoreRechargeAccount(input as never);
    expect(result.unidentifiedCheckoutRecovery).toBe(true);
    expect(result.originalCheckoutIdentifier).toBeUndefined();
    expect(result.ownedProfile?.profileId).toBe(profileId);
    expect(repository.updateJob).toHaveBeenCalledOnce();
  });
  it('ignores empty, scalar and ordinary failed history before exact original discovery', async () => {
    const { input, previous } = fixture();
    input.tx.idBusinessV2RechargeJob.findMany.mockResolvedValue([
      { ...previous, id: '33333333-3333-4333-8333-333333333333', result: null },
      { ...previous, id: '44444444-4444-4444-8444-444444444444', result: 'synthetic_failure' },
      {
        ...previous,
        id: '55555555-5555-4555-8555-555555555555',
        result: { status: 'blocked', reason: 'browser_operation_failed', checkout_requests_sent: 0 }
      },
      previous
    ] as never);
    const repository = new RechargeRepository({} as never);
    await expect(
      repository.originalCheckoutForAccount(
        input.tx as never,
        'owner',
        accountKey,
        'plus',
        input.job.id,
        undefined,
        sourceId,
        ['oaics_other_expired']
      )
    ).resolves.toBeUndefined();
  });
  it.each([
    'missing-source',
    'different-source',
    'payment',
    'confirmation',
    'unknown-checkout',
    'invalid-identifier'
  ])('nonempty expired exclusions do not permit an unidentified %s', async (kind) => {
    const { input, previous } = fixture();
    const allowedSource =
      kind === 'missing-source'
        ? undefined
        : kind === 'different-source'
          ? '33333333-3333-4333-8333-333333333333'
          : sourceId;
    if (kind === 'payment') previous.result.payment_attempted = true;
    if (kind === 'confirmation') previous.result.confirmation_requests_sent = 1;
    if (kind === 'unknown-checkout')
      Object.assign(previous.result, {
        checkout_requests_sent: 0,
        checkout_outcome: 'unknown',
        reason: 'browser_operation_failed'
      });
    if (kind === 'invalid-identifier')
      Object.assign(previous.result, { checkout_identifier: 'invalid' });
    const repository = new RechargeRepository({} as never);
    await expect(
      repository.originalCheckoutForAccount(
        input.tx as never,
        'owner',
        accountKey,
        'plus',
        input.job.id,
        undefined,
        allowedSource,
        ['oaics_other_expired']
      )
    ).rejects.toThrow('原订单编号未核实');
  });
  const login = (id: string, profile: string, parent?: string, verified = true) => ({
    ...source(),
    id,
    result: {
      mode: 'open_browser',
      status: verified ? 'session_ready' : 'blocked',
      account_matched: verified,
      payment_attempted: false,
      payment_requests_sent: 0,
      browser_profile_id: profile,
      ...(parent
        ? { browser_profile_missing_confirmed: true, replaced_browser_profile_id: parent }
        : {})
    }
  });
  const loginId = '44444444-4444-4444-8444-444444444444';
  const replacement = 'd'.repeat(32);
  const latest = 'e'.repeat(32);

  it('finds the checkout source after another login retained the same window', async () => {
    const { input, previous, repository } = fixture();
    const loggedIn = login(loginId, profileId);
    repository.findJob.mockResolvedValue(loggedIn as never);
    repository.retainedProfileForAccount.mockResolvedValue({
      sourceJobId: loginId,
      profileId,
      accountKey
    });
    repository.finishedJobsForUnidentifiedCheckout.mockResolvedValue([loggedIn, previous] as never);
    const result = await restoreRechargeAccount(input as never);
    expect(result.unidentifiedCheckoutRecovery).toBe(true);
    expect(result.originalCheckoutIdentifier).toBeUndefined();
    expect(result.ownedProfile?.sourceJobId).toBe(loginId);
  });

  it('recovers through confirmed replacements only after every replacement identity is verified', async () => {
    const { input, previous, repository } = fixture();
    const firstAttempt = login(
      '55555555-5555-4555-8555-555555555555',
      replacement,
      profileId,
      false
    );
    const firstReady = login('66666666-6666-4666-8666-666666666666', replacement);
    const lastReady = login(loginId, latest, replacement);
    const history = [lastReady, firstReady, firstAttempt, previous];
    repository.findJob.mockResolvedValue(lastReady as never);
    repository.retainedProfileForAccount.mockResolvedValue({
      sourceJobId: loginId,
      profileId: latest,
      accountKey
    });
    repository.finishedJobsForUnidentifiedCheckout.mockResolvedValue(history as never);
    const result = await restoreRechargeAccount(input as never);
    expect(result.unidentifiedCheckoutRecovery).toBe(true);
    expect(result.ownedProfile?.profileId).toBe(latest);
    expect(result.originalCheckoutIdentifier).toBeUndefined();
    expect(input.tx.idBusinessV2RechargeJob.findMany).toHaveBeenCalled();
  });

  it.each([
    'missing-link',
    'unverified',
    'other-owner',
    'other-account',
    'payment',
    'conflicting-parent',
    'cycle'
  ])('does not grant replacement discovery for %s', (kind) => {
    const edge = login(loginId, replacement, profileId);
    const history = [edge, source()];
    if (kind === 'missing-link') delete edge.result.replaced_browser_profile_id;
    if (kind === 'unverified') edge.result.account_matched = false;
    if (kind === 'other-owner') edge.ownerId = 'other';
    if (kind === 'other-account') edge.accountKey = 'c'.repeat(64);
    if (kind === 'payment') edge.result.payment_attempted = true;
    if (kind === 'conflicting-parent')
      history.push(login('77777777-7777-4777-8777-777777777777', replacement, latest));
    if (kind === 'cycle') edge.result.replaced_browser_profile_id = replacement;
    expect(
      findUnidentifiedCheckoutSource(history, 'owner', accountKey, 'plus', replacement)
    ).toBeUndefined();
  });

  it('does not choose between two unidentified original checkout attempts', () => {
    expect(
      findUnidentifiedCheckoutSource(
        [
          login(loginId, profileId),
          source(),
          { ...source(), id: '77777777-7777-4777-8777-777777777777' }
        ],
        'owner',
        accountKey,
        'plus',
        profileId
      )
    ).toBeUndefined();
  });

  it('rejects when the complete checkout history cannot be verified', async () => {
    const { input, repository } = fixture();
    const loggedIn = login(loginId, profileId);
    repository.findJob.mockResolvedValue(loggedIn as never);
    repository.finishedJobsForUnidentifiedCheckout.mockRejectedValue(
      new Error('原结算历史尚未完整核验，禁止恢复原窗口')
    );
    await expect(restoreRechargeAccount(input as never)).rejects.toThrow();
    expect(repository.updateJob).not.toHaveBeenCalled();
  });

  it('rejects a checkout record for another plan', async () => {
    const { input, records, repository } = fixture();
    records[0]!.document.target_plan = 'pro-5x';
    await expect(restoreRechargeAccount(input as never)).rejects.toThrow();
    expect(repository.updateJob).not.toHaveBeenCalled();
  });
  it.each(['owner', 'account', 'profile', 'payment', 'record'])(
    'rejects discovery when the %s binding is wrong',
    async (kind) => {
      const { input, previous, records } = fixture();
      if (kind === 'owner') previous.ownerId = 'other';
      if (kind === 'account') previous.accountKey = 'c'.repeat(64);
      if (kind === 'profile') previous.result.browser_profile_id = 'd'.repeat(32);
      if (kind === 'payment') previous.result.payment_attempted = true;
      if (kind === 'record') records[0]!.document.confirmation_requests_sent = 1;
      await expect(restoreRechargeAccount(input as never)).rejects.toThrow();
    }
  );
  it('does not skip a second ambiguous historical checkout', () => {
    const first = source(),
      second = { ...source(), id: '33333333-3333-4333-8333-333333333333' };
    expect(() =>
      findOriginalRechargeCheckout([first, second], 'owner', accountKey, 'plus', sourceId)
    ).toThrow();
  });
  it('any payment or accepted confirmation prevents discovery', () => {
    for (const changed of [
      { payment_attempted: true },
      { confirmation_requests_sent: 1 },
      { payment_requests_sent: 1 },
      { checkout_requests_sent: 2 },
      { manual_confirmation_accepted: true }
    ]) {
      expect(isUnidentifiedUnpaidCheckout({ ...document(), ...changed })).toBe(false);
    }
  });
  it('retains controlled request diagnostics and discards raw body and credentials', () => {
    expect(
      safeDocument({
        checkout_request_body_state: 'unavailable',
        checkout_request_plan_state: 'missing',
        checkout_recovered_from_original: true,
        post_data: 'DO_NOT_KEEP',
        authorization: 'DO_NOT_KEEP'
      })
    ).toEqual({
      checkout_request_body_state: 'unavailable',
      checkout_request_plan_state: 'missing',
      checkout_recovered_from_original: true
    });
  });
});

describe('web direct failed checkout marker discovery', () => {
  const marker = () => ({
    status: 'checkout_attempted',
    stage: 'checkout_create',
    checkout_outcome: 'unknown',
    transport: 'official_browser',
    account_matched: true,
    current_plan_before: 'free',
    payment_status: 'not_attempted',
    run_id: 'd'.repeat(32),
    created_at: 1000,
    target_plan: 'plus',
    plan: 'chatgptplusplan'
  });
  function webFixture() {
    const f = fixture();
    Object.assign(f.previous.result, {
      transport: 'web_direct',
      reason: 'official_checkout_http_failed',
      http_status: 400
    });
    Object.assign(f.previous, { createdAt: new Date(999000), updatedAt: new Date(1001000) });
    f.records[0]!.document = marker();
    return f;
  }
  it('joins exact HTTP400 source facts to its earlier marker without inventing counts', async () => {
    const f = webFixture();
    const before = structuredClone(f.records[0]!.document);
    expect((await restoreRechargeAccount(f.input as never)).unidentifiedCheckoutRecovery).toBe(
      true
    );
    expect(f.records[0]!.document).toEqual(before);
  });
  it.each([
    'missing-count',
    'payment',
    'accepted',
    'different-profile',
    'old-marker',
    'future-marker',
    'missing-source',
    'unknown-http'
  ])('rejects %s', async (kind) => {
    const f = webFixture();
    if (kind === 'missing-count')
      delete (f.previous.result as Record<string, unknown>).checkout_requests_sent;
    if (kind === 'payment') f.previous.result.payment_requests_sent = 1;
    if (kind === 'accepted')
      Object.assign(f.previous.result, { manual_confirmation_accepted: true });
    if (kind === 'different-profile') f.previous.result.browser_profile_id = 'f'.repeat(32);
    if (kind === 'old-marker') f.records[0]!.document.created_at = 998;
    if (kind === 'future-marker') f.records[0]!.document.created_at = 1002;
    if (kind === 'missing-source') f.repository.findJob.mockResolvedValue(null as never);
    if (kind === 'unknown-http') Object.assign(f.previous.result, { http_status: 500 });
    await expect(restoreRechargeAccount(f.input as never)).rejects.toThrow();
    expect(f.repository.updateJob).not.toHaveBeenCalled();
  });
});
