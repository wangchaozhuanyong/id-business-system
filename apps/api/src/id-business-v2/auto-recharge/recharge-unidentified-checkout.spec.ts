import { describe, expect, it, vi } from 'vitest';
import { restoreRechargeAccount } from './recharge-account-restore';
import { findOriginalRechargeCheckout } from './recharge-job-helpers';
import { RechargeRepository } from './persistence/recharge.repository';
import { isUnidentifiedUnpaidCheckout } from './recharge-unidentified-checkout';
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
  const records = [
    { ownerId: 'owner', fileKey: `${accountKey}.json`, revision: 2, document: document() }
  ];
  const tx = { idBusinessV2RechargeJob: { findMany: vi.fn().mockResolvedValue([previous]) } };
  const repository = {
    records: vi.fn().mockResolvedValue(records),
    retainedProfileForAccount: vi
      .fn()
      .mockResolvedValue({ sourceJobId: sourceId, profileId, accountKey }),
    findJob: vi.fn().mockResolvedValue(previous),
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
