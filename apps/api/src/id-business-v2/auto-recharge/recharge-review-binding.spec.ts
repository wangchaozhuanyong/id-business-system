import { describe, expect, it, vi } from 'vitest';
import { restoreRechargeAccount } from './recharge-account-restore';
import { RechargeRepository } from './persistence/recharge.repository';
const key = 'a'.repeat(64),
  sourceId = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const source = {
    id: sourceId,
    ownerId: 'owner',
    accountKey: key,
    plan: 'plus',
    result: { checkout_identifier: 'cs_original' }
  };
  const current = {
    id: '22222222-2222-4222-8222-222222222222',
    ownerId: 'owner',
    accountKey: key,
    plan: 'plus',
    action: 'bitbrowser',
    result: { recheck_only: true, source_job_id: sourceId, payment_requests_sent: 0 }
  };
  const records = [
    {
      ownerId: 'owner',
      accountKey: key,
      fileKey: key + '.json',
      revision: 1,
      document: { checkout_identifier: 'cs_original', target_plan: 'plus' }
    }
  ];
  const repository = {
    records: vi.fn().mockResolvedValue(records),
    findJob: vi.fn().mockResolvedValue(source),
    retainedProfileForAccount: vi.fn().mockResolvedValue({
      sourceJobId: '33333333-3333-4333-8333-333333333333',
      profileId: 'b'.repeat(32),
      accountKey: key
    }),
    restoreCheckoutIdentifier: new RechargeRepository({} as never).restoreCheckoutIdentifier,
    updateJob: vi.fn()
  };
  return {
    source,
    current,
    records,
    repository,
    run: () =>
      restoreRechargeAccount({
        tx: {} as never,
        job: current as never,
        callback: { type: 'restore', accountKey: key },
        repository: repository as never
      })
  };
}
describe('original-order read-only binding', () => {
  it('uses the later API-owned login window while retaining the exact original checkout', async () => {
    const f = fixture(),
      result = await f.run();
    expect(result.originalCheckoutIdentifier).toBe('cs_original');
    expect(result.ownedProfile?.profileId).toBe('b'.repeat(32));
    expect(f.repository.updateJob).toHaveBeenCalledWith(
      {},
      f.current.id,
      expect.objectContaining({ accountKey: key })
    );
  });
  it.each(['owner', 'account', 'checkout', 'source-chain'])(
    'rejects changed %s before updating the recheck task',
    async (kind) => {
      const f = fixture();
      if (kind === 'owner') f.source.ownerId = 'other';
      if (kind === 'account') f.source.accountKey = 'c'.repeat(64);
      if (kind === 'checkout') f.records[0]!.document.checkout_identifier = 'cs_different';
      if (kind === 'source-chain') Object.assign(f.source.result, { recheck_only: true });
      await expect(f.run()).rejects.toThrow();
      expect(f.repository.updateJob).not.toHaveBeenCalled();
    }
  );
  it('finished resolution records do not reserve an execution slot', async () => {
    const repository = new RechargeRepository({} as never);
    const check = repository as unknown as {
      assertExecutionResources: (tx: unknown, id: string, value: object) => Promise<void>;
    };
    const tx = {
      idBusinessV2RechargeJob: { findFirst: vi.fn().mockResolvedValue({ ownerId: 'owner' }) }
    };
    await check.assertExecutionResources(tx, sourceId, { action: 'bitbrowser', state: 'finished' });
    expect(tx.idBusinessV2RechargeJob.findFirst).not.toHaveBeenCalled();
  });
});
