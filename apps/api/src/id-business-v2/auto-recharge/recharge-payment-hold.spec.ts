import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SharedBankCardRepository,
  releaseExpiredBitBrowserCardHold
} from '../bank-card-pool/public-api';
import { BankRechargeCardService } from './bank-recharge-card.service';
import { RechargeService } from './recharge.service';
import {
  prepareDirectRechargeQuote,
  confirmDirectRechargePayment
} from './recharge-direct-payment';
import { finalizeRechargeCard } from './recharge-card-billing';
import { hash } from './recharge-validation';
import { RechargeRepository } from './persistence/recharge.repository';
import { rechargeAvailability } from './recharge-availability';
import { resolvedDeclinedPayment, resolvedDeclinedCheckout } from './recharge-noncharge-proof';
import {
  closeOfficialTerminalFailure,
  hasOfficialTerminalNoncharge,
  TERMINAL_FAILURE_KEY
} from './recharge-terminal-failure';
import { V2CommandTransactionManager } from '../runtime/public-api';
import {
  CARD_ATTEMPT_KEY,
  reconcileRechargePaymentHolds,
  recoverRechargeCardAttempt,
  settleResolvedRechargeCard
} from './persistence/recharge-payment-hold.repository';

const sourceId = '11111111-1111-4111-8111-111111111111';
const cardId = '22222222-2222-4222-8222-222222222222';
const owner = { id: 'owner' };
const quote = {
  plan: 'plus',
  today: { amount: '20.00', amount_minor: 2000, currency: 'USD' },
  tax: { amount: '0.00', amount_minor: 0, currency: 'USD' },
  renewal: { amount: '20.00', amount_minor: 2000, currency: 'USD' },
  renewal_interval: 'monthly'
};

beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgresql://unit.invalid/only');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-19T10:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function fixture() {
  const job = {
    id: sourceId,
    ownerId: owner.id,
    cardId: 'legacy',
    billingNameEncrypted: null,
    accountKey: 'a'.repeat(64),
    action: 'bitbrowser',
    state: 'running',
    plan: 'plus',
    nonceHash: hash('synthetic-agent'),
    createdAt: new Date(Date.now() - 60000),
    leaseUntil: new Date(Date.now() + 45 * 60000),
    result: {
      transport: 'web_direct',
      mode: 'payment',
      addressId: '44444444-4444-4444-8444-444444444444',
      locked_currency: 'USD',
      checkout_identifier: 'oaics_hold',
      account_matched: true,
      current_plan: 'free',
      payment_attempted: false,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0
    } as Record<string, unknown>
  };
  const card = {
    id: cardId,
    numberHash: 'synthetic-hash',
    numberEncrypted: 'not-used',
    expiry: '12/99',
    allowedPlans: ['plus'],
    last4: '0000',
    expiryMonth: 12,
    expiryYear: 2099,
    leaseOwner: sourceId as string | null,
    leaseExpiresAt: new Date(Date.now() + 45 * 60000) as Date | null,
    leaseId: 'lease' as string | null,
    leaseVersion: 1,
    successCount: 0,
    declineCount: 0,
    status: 'active'
  };
  const records = new Map<
    string,
    { fileKey: string; accountKey: string; ownerId: string; revision: number; document: object }
  >();
  const history = [job];
  const audits: { createdAt: Date; afterData: object }[] = [];
  const tx = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => audits) },
    idBusinessV2RechargeJob: {
      findUnique: vi.fn(async ({ where }) => history.find((item) => item.id === where.id) ?? null),
      findMany: vi.fn(async ({ where }) =>
        history.filter((item) => {
          if (where.id?.in) return where.id.in.includes(item.id) && item.ownerId === where.ownerId;
          const attempt = item.result[CARD_ATTEMPT_KEY] as { cardId?: string } | undefined;
          return item.id !== where.id?.not && attempt?.cardId === cardId;
        })
      )
    },
    idBusinessV2RechargeRecord: {
      updateMany: vi.fn(async ({ where, data }) => {
        const record = records.get(where.fileKey);
        if (!record || record.revision !== where.revision) return { count: 0 };
        record.revision++;
        record.document = data.document;
        return { count: 1 };
      })
    },
    idBusinessV2BankRechargeCard: {
      findUnique: vi.fn(async () => ({ id: 'legacy', numberHash: card.numberHash }))
    },
    onlineRechargeConfig: { findUnique: vi.fn(async () => null) },
    onlineRechargeCard: {
      upsert: vi.fn(async () => card),
      findUnique: vi.fn(async () => card),
      findMany: vi.fn(async ({ where }) => {
        if (where.leaseOwner === sourceId || where.leaseOwner?.not === null)
          return card.leaseOwner ? [card] : [];
        return [card];
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.leaseOwner !== undefined && where.leaseOwner !== card.leaseOwner)
          return { count: 0 };
        if (
          where.OR &&
          !where.OR.some(
            (item: { leaseOwner: string | null }) => item.leaseOwner === card.leaseOwner
          )
        )
          return { count: 0 };
        if (
          where.leaseExpiresAt &&
          where.leaseExpiresAt.getTime() !== card.leaseExpiresAt?.getTime()
        )
          return { count: 0 };
        for (const [key, value] of Object.entries(data))
          (card as Record<string, unknown>)[key] =
            value && typeof value === 'object' && 'increment' in value
              ? Number((card as Record<string, unknown>)[key]) + Number(value.increment)
              : value;
        return { count: 1 };
      })
    }
  };
  const transactions = { execute: vi.fn(async (work) => work(tx)) },
    audit = { append: vi.fn() };
  const pool = new SharedBankCardRepository(
    tx as never,
    {} as never,
    transactions as never,
    audit as never
  );
  const cards = new BankRechargeCardService(
    {} as never,
    {} as never,
    transactions as never,
    audit as never,
    {} as never,
    pool
  );
  const repository = {
    lock: vi.fn(),
    findJob: vi.fn(async () => job),
    records: vi.fn(async () => [...records.values()]),
    closeOfficialDeclinedRecords: vi.fn(async (_tx: unknown, _job: unknown, _proof: unknown) => {
      void [_tx, _job, _proof];
    }),
    updateJob: vi.fn(async (_tx, id, data) =>
      Object.assign(history.find((item) => item.id === id)!, data)
    ),
    saveRecord: vi.fn(async (_tx, value) => {
      const saved = { ...value, revision: value.revision + 1 };
      records.set(value.fileKey, saved);
      return saved;
    })
  };
  const service = new RechargeService(
    repository as never,
    { markUsed: vi.fn(async () => ({ changed: false })) } as never,
    transactions as never,
    audit as never,
    undefined,
    undefined,
    undefined,
    cards
  );
  const authorize = async (extra: Record<string, unknown> = {}) => {
    const prepared = await prepareDirectRechargeQuote({
      tx: tx as never,
      job: job as never,
      repository: repository as never,
      audit: audit as never,
      report: {
        quote,
        account_matched: true,
        checkout_identifier: 'oaics_hold',
        current_plan_before: 'free',
        billing_fingerprint: 'b'.repeat(64),
        quote_authority: 'official_checkout_response',
        ...extra
      }
    });
    await confirmDirectRechargePayment({
      tx: tx as never,
      job: job as never,
      repository: repository as never,
      audit: audit as never,
      cards,
      operator: owner as never,
      value: {
        nonce: prepared.nonce,
        quoteDigest: prepared.quote_digest,
        checkoutIdentifier: String(extra.upgrade_identifier ?? 'oaics_hold')
      }
    });
  };
  return {
    job,
    card,
    history,
    audits,
    records,
    tx,
    pool,
    cards,
    repository,
    service,
    audit,
    authorize
  };
}

describe('真实授权到两分钟释放、额度保留与迟到结算', () => {
  it('报价确认真实建立pending且后续requires_action进度不能续期', async () => {
    const f = fixture();
    await f.authorize();
    const deadline = f.job.leaseUntil.getTime();
    expect(deadline).toBe(Date.now() + 120000);
    expect(f.card.leaseExpiresAt?.getTime()).toBe(deadline);
    expect(f.job.result[CARD_ATTEMPT_KEY]).toMatchObject({ cardId, outcome: 'pending' });
    vi.setSystemTime(new Date(Date.now() + 60000));
    await f.service.callback(
      sourceId,
      {
        type: 'progress',
        result: {
          stage: 'payment_human_verification',
          payment_status: 'requires_action',
          payment_attempted: true,
          payment_requests_sent: 1,
          confirmation_requests_sent: 1
        }
      },
      { localToken: 'synthetic-agent' }
    );
    expect(f.job.leaseUntil.getTime()).toBe(deadline);
    expect(await releaseExpiredBitBrowserCardHold(f.tx as never, f.card)).toBe(false);
  });

  it.each(['unknown', 'requires_action'])(
    '失联%s不靠原owner列表即可在全池options释放，但不伪造失败或清除pending',
    async (status) => {
      const f = fixture();
      await f.authorize();
      f.job.result.payment_status = status;
      vi.setSystemTime(new Date(Date.now() + 120001));
      const before = structuredClone(f.job.result);
      expect((await f.pool.options('plus')).items).toHaveLength(1);
      expect(f.card.leaseOwner).toBeNull();
      expect(f.job.result).toEqual(before);
      expect(f.job.result[CARD_ATTEMPT_KEY]).toMatchObject({ outcome: 'pending' });
      expect(f.tx.auditLog.create).toHaveBeenCalledOnce();
    }
  );

  it('成功1+未决1已经满额，逻辑释放也不能拿到第三单', async () => {
    const f = fixture();
    await f.authorize();
    f.card.successCount = 1;
    vi.setSystemTime(new Date(Date.now() + 120001));
    expect((await f.pool.options('plus')).items).toHaveLength(0);
    await expect(
      f.pool.reserveLegacy(
        f.tx as never,
        { numberHash: f.card.numberHash, numberEncrypted: 'not-used', expiry: '12/99' } as never,
        'plus',
        'new-job'
      )
    ).rejects.toThrow('上限');
  });

  it.each([true, false])(
    '释放后迟到verified=%s结算恰好一次，绝不清掉新job lease',
    async (verified) => {
      const f = fixture();
      await f.authorize();
      vi.setSystemTime(new Date(Date.now() + 120001));
      await f.pool.options('plus');
      f.card.leaseOwner = 'new-job';
      const report = {
        payment_attempted: true,
        payment_requests_sent: 1,
        payment_status: verified ? 'paid' : 'declined'
      };
      for (let i = 0; i < 2; i++)
        await finalizeRechargeCard({
          tx: f.tx as never,
          job: f.job as never,
          report,
          order: verified ? { cardId: 'legacy', rechargeJobId: sourceId } : null,
          repository: f.repository as never,
          cards: f.cards
        });
      expect(f.card).toMatchObject({
        leaseOwner: 'new-job',
        successCount: verified ? 1 : 0,
        declineCount: verified ? 0 : 1
      });
      expect(f.job.result[CARD_ATTEMPT_KEY]).toMatchObject({
        outcome: verified ? 'paid' : 'declined'
      });
    }
  );

  it('回调中的私有pending/settled及伪造时间不能写入', async () => {
    const f = fixture();
    await f.authorize();
    for (const type of ['progress', 'ledger', 'finished'])
      await expect(
        f.service.callback(
          sourceId,
          {
            type,
            result: {
              [CARD_ATTEMPT_KEY]: {
                cardId,
                authorizedAt: new Date(0).toISOString(),
                outcome: 'paid'
              }
            }
          },
          { localToken: 'synthetic-agent' }
        )
      ).rejects.toThrow('内部字段');
  });

  it('150个更新的完成历史不能遮住真正持卡的旧source，唯一确认审计恢复原时间', async () => {
    const f = fixture();
    await f.authorize();
    delete f.job.result[CARD_ATTEMPT_KEY];
    delete (f.job.result._direct_confirmation_v1 as Record<string, unknown>).consumedAt;
    f.audits.push({
      createdAt: new Date(),
      afterData: { checkoutIdentifier: 'oaics_hold', quoteDigest: f.job.result.quote_digest }
    });
    for (let i = 0; i < 150; i++)
      f.history.push({ ...f.job, id: `newer-${i}`, result: { payment_status: 'paid' } });
    vi.setSystemTime(new Date(Date.now() + 120001));
    await reconcileRechargePaymentHolds({
      tx: f.tx as never,
      repository: f.repository as never,
      cards: f.cards,
      audit: f.audit as never,
      ownerId: owner.id
    });
    expect(f.job.state).toBe('finished');
    expect(f.card.leaseOwner).toBeNull();
    expect(f.job.result[CARD_ATTEMPT_KEY]).toMatchObject({
      authorizedAt: f.audits[0]!.createdAt.toISOString(),
      outcome: 'pending'
    });
    expect(f.tx.idBusinessV2RechargeJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: [sourceId] } }) })
    );
  });

  it.each(['missing', 'multiple', 'mismatch'])(
    '旧时间审计%s不得以updatedAt或客户端时间兜底',
    async (kind) => {
      const f = fixture();
      await f.authorize();
      delete f.job.result[CARD_ATTEMPT_KEY];
      delete (f.job.result._direct_confirmation_v1 as Record<string, unknown>).consumedAt;
      if (kind !== 'missing')
        f.audits.push({
          createdAt: new Date(),
          afterData: {
            checkoutIdentifier: kind === 'mismatch' ? 'oaics_other' : 'oaics_hold',
            quoteDigest: f.job.result.quote_digest
          }
        });
      if (kind === 'multiple') f.audits.push(f.audits[0]!);
      expect(
        await recoverRechargeCardAttempt(f.tx as never, f.job as never, f.cards)
      ).toBeUndefined();
      expect(f.card.leaseOwner).toBe(sourceId);
    }
  );

  it('授权/恢复多卡同owner或legacy映射不符必须拒绝', async () => {
    const f = fixture();
    f.tx.onlineRechargeCard.findMany.mockResolvedValueOnce([f.card, { ...f.card, id: 'other' }]);
    await expect(f.authorize()).rejects.toThrow('多张银行卡');
    const g = fixture();
    g.tx.idBusinessV2BankRechargeCard.findUnique.mockResolvedValueOnce({
      id: 'legacy',
      numberHash: 'wrong'
    });
    await expect(g.authorize()).rejects.toThrow('归属');
  });

  it('120秒后迟到的已绑定intent明确拒付同步结束job和两份ledger，原账号可继续，重复不再结算', async () => {
    const f = fixture();
    await f.authorize();
    await f.service.callback(
      sourceId,
      {
        type: 'progress',
        result: {
          payment_intent_identifier: 'pi_bound',
          payment_status: 'unknown',
          stage: 'payment_result'
        }
      },
      { localToken: 'synthetic-agent' }
    );
    f.records.set(`${f.job.accountKey}.json`, {
      fileKey: `${f.job.accountKey}.json`,
      accountKey: f.job.accountKey,
      ownerId: owner.id,
      revision: 1,
      document: {
        account_key: f.job.accountKey,
        target_plan: 'plus',
        checkout_identifier: 'oaics_hold',
        payment_status: 'not_attempted',
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0
      }
    });
    const actual = new RechargeRepository({} as never);
    vi.spyOn(actual, 'records').mockImplementation(f.repository.records as never);
    f.repository.closeOfficialDeclinedRecords.mockImplementation((tx, job, proof) =>
      actual.closeOfficialDeclinedRecords(tx as never, job as never, proof as never)
    );
    vi.setSystemTime(new Date(Date.now() + 120001));
    await f.pool.options('plus');
    f.card.leaseOwner = 'new-job';
    const terminal = {
      type: 'finished',
      result: {
        status: 'payment_failed',
        stage: 'payment_result',
        quote,
        target_plan: 'plus',
        checkout_identifier: 'oaics_hold',
        payment_intent_identifier: 'pi_bound',
        account_matched: true,
        current_plan: 'free',
        payment_status: 'declined',
        payment_attempted: true,
        payment_requests_sent: 1,
        confirmation_requests_sent: 1
      }
    };
    await f.service.callback(sourceId, terminal, { localToken: 'synthetic-agent' });
    expect(f.job.result[TERMINAL_FAILURE_KEY]).toMatchObject({
      kind: 'bound_payment_intent_declined',
      paymentIntentIdentifier: 'pi_bound'
    });
    expect(resolvedDeclinedPayment(f.job.result)).toBe(true);
    expect(rechargeAvailability(f.job as never, []).accountPaymentRestricted).toBe(false);
    const values = [...f.records.values()];
    expect(values.filter((item) => resolvedDeclinedPayment(item.document))).toHaveLength(1);
    expect(values.filter((item) => resolvedDeclinedCheckout(item.document))).toHaveLength(1);
    expect(actual.restoreCheckoutIdentifier(values, f.job.accountKey, 'plus', [])).toBe(
      'oaics_hold'
    );
    expect(f.card).toMatchObject({ leaseOwner: 'new-job', declineCount: 1, successCount: 0 });
    await f.service.callback(sourceId, terminal, { localToken: 'synthetic-agent' });
    expect(f.tx.idBusinessV2RechargeRecord.updateMany).toHaveBeenCalledTimes(2);
    expect(f.card).toMatchObject({ leaseOwner: 'new-job', declineCount: 1 });
    const savedJob = JSON.stringify(f.job.result),
      savedRecords = JSON.stringify([...f.records]);
    for (const payment_status of ['unknown', 'requires_action', 'paid']) {
      await expect(
        f.service.callback(
          sourceId,
          {
            ...terminal,
            result: {
              ...terminal.result,
              status: 'payment_result_unknown',
              payment_status,
              ...(payment_status === 'paid'
                ? {
                    payment_evidence: {
                      kind: 'payment_intent',
                      identifier: 'pi_bound',
                      amount_minor: 2000,
                      currency: 'USD'
                    }
                  }
                : {})
            }
          },
          { localToken: 'synthetic-agent' }
        )
      ).rejects.toThrow('终态');
    }
    const payment = f.records.get(`payments/${hash('oaics_hold')}.json`)!;
    const { [TERMINAL_FAILURE_KEY]: privateProof, ...publicDocument } = payment.document as Record<
      string,
      unknown
    >;
    void privateProof;
    const rawTx = {
      ...f.tx,
      idBusinessV2RechargeRecord: {
        ...f.tx.idBusinessV2RechargeRecord,
        findUnique: vi.fn(async () => payment),
        upsert: vi.fn()
      }
    };
    await expect(
      actual.saveRecord(rawTx as never, {
        ...payment,
        document: { ...publicDocument, payment_status: 'unknown' }
      })
    ).rejects.toThrow('终态');
    expect(rawTx.idBusinessV2RechargeRecord.upsert).not.toHaveBeenCalled();
    expect(JSON.stringify(f.job.result)).toBe(savedJob);
    expect(JSON.stringify([...f.records])).toBe(savedRecords);
    expect(f.card).toMatchObject({ leaseOwner: 'new-job', declineCount: 1, successCount: 0 });
  });

  it.each([
    ['go', 'plus'],
    ['plus', 'pro-5x'],
    ['plus', 'pro-20x'],
    ['plus', 'pro-500']
  ])('%s升级%s的已绑定intent拒付只结束upg付款，原付费订阅与root保持原样', async (current, plan) => {
    const f = fixture(),
      upgradeQuote = { ...quote, plan },
      upgrade = {
        operation: 'subscription_upgrade',
        upgrade_identifier: `upg_${'1'.repeat(32)}`,
        current_plan_before: current,
        target_plan: plan,
        quote_authority: 'official_upgrade_preview',
        quote: upgradeQuote
      };
    f.job.plan = plan;
    f.card.allowedPlans = [plan];
    Object.assign(f.job.result, upgrade, { current_plan: current });
    delete f.job.result.checkout_identifier;
    const originalKey = `${f.job.accountKey}${current === 'plus' ? '' : '-go'}.json`;
    f.records.set(originalKey, {
      fileKey: originalKey,
      accountKey: f.job.accountKey,
      ownerId: owner.id,
      revision: 9,
      document: {
        checkout_identifier: 'oaics_paid_original',
        target_plan: current,
        payment_status: 'paid',
        payment_evidence: {
          kind: 'checkout_session',
          identifier: 'oaics_paid_original',
          amount_minor: 500,
          currency: 'USD'
        }
      }
    });
    const original = JSON.stringify(f.records.get(originalKey));
    await f.authorize(upgrade);
    await f.service.callback(
      sourceId,
      {
        type: 'progress',
        result: {
          ...upgrade,
          payment_intent_identifier: 'pi_upgrade',
          upgrade_payment_intent_identifier: 'pi_upgrade',
          stage: 'payment_result'
        }
      },
      { localToken: 'synthetic-agent' }
    );
    const actual = new RechargeRepository({} as never);
    vi.spyOn(actual, 'records').mockImplementation(f.repository.records as never);
    f.repository.closeOfficialDeclinedRecords.mockImplementation((tx, job, proof) =>
      actual.closeOfficialDeclinedRecords(tx as never, job as never, proof as never)
    );
    vi.setSystemTime(new Date(Date.now() + 120001));
    await f.pool.options('plus');
    f.card.leaseOwner = 'new-job';
    const terminal = {
      type: 'finished',
      result: {
        ...upgrade,
        quote: upgradeQuote,
        payment_intent_identifier: 'pi_upgrade',
        upgrade_payment_intent_identifier: 'pi_upgrade',
        status: 'payment_failed',
        stage: 'payment_result',
        current_plan: current,
        account_matched: true,
        payment_status: 'declined',
        payment_attempted: true,
        payment_requests_sent: 1,
        confirmation_requests_sent: 1
      }
    };
    await f.service.callback(sourceId, terminal, { localToken: 'synthetic-agent' });
    expect(resolvedDeclinedPayment(f.job.result)).toBe(true);
    expect(f.job.result[TERMINAL_FAILURE_KEY]).toMatchObject({
      checkoutIdentifier: upgrade.upgrade_identifier,
      paymentIntentIdentifier: 'pi_upgrade'
    });
    expect(f.job.result.current_plan).toBe(current);
    const payment = f.records.get(`payments/${hash(upgrade.upgrade_identifier)}.json`)!;
    expect(resolvedDeclinedPayment(payment.document)).toBe(true);
    expect(rechargeAvailability(f.job as never, []).accountPaymentRestricted).toBe(false);
    const paymentDoc = payment.document as Record<string, unknown>;
    expect(
      hasOfficialTerminalNoncharge({ ...paymentDoc, upgrade_payment_intent_identifier: 'pi_other' })
    ).toBe(false);
    expect(hasOfficialTerminalNoncharge({ ...paymentDoc, current_plan_before: 'free' })).toBe(
      false
    );
    expect(JSON.stringify(f.records.get(originalKey))).toBe(original);
    expect(f.tx.idBusinessV2RechargeRecord.updateMany).toHaveBeenCalledTimes(1);
    expect(f.card).toMatchObject({ leaseOwner: 'new-job', declineCount: 1, successCount: 0 });
    await f.service.callback(sourceId, terminal, { localToken: 'synthetic-agent' });
    expect(f.tx.idBusinessV2RechargeRecord.updateMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    'unbound',
    'previous-alias',
    'report-upgrade-pi',
    'report-alias',
    'confirmation-ref',
    'confirmation-digest',
    'unsupported',
    'unknown',
    'requires_action'
  ])('升级终态拒绝%s，不能靠终态首次PI或矛盾别名自动结束', async (kind) => {
    const f = fixture(),
      upgrade = {
        operation: 'subscription_upgrade',
        upgrade_identifier: `upg_${'3'.repeat(32)}`,
        current_plan_before: 'go',
        target_plan: 'plus',
        quote_authority: 'official_upgrade_preview'
      };
    Object.assign(f.job.result, upgrade, { current_plan: 'go' });
    delete f.job.result.checkout_identifier;
    await f.authorize(upgrade);
    Object.assign(f.job.result, {
      upgrade_payment_intent_identifier: 'pi_upgrade',
      payment_intent_identifier: 'pi_upgrade'
    });
    (f.job.result[CARD_ATTEMPT_KEY] as Record<string, unknown>).outcome = 'declined';
    const report: Record<string, unknown> = {
      ...upgrade,
      quote,
      upgrade_payment_intent_identifier: 'pi_upgrade',
      payment_intent_identifier: 'pi_upgrade',
      status: 'payment_failed',
      stage: 'payment_result',
      account_matched: true,
      payment_status: 'declined',
      payment_attempted: true,
      payment_requests_sent: 1,
      confirmation_requests_sent: 1
    };
    const confirmation = f.job.result._direct_confirmation_v1 as Record<string, unknown>;
    if (kind === 'unbound') delete f.job.result.upgrade_payment_intent_identifier;
    if (kind === 'previous-alias') f.job.result.payment_intent_identifier = 'pi_other';
    if (kind === 'report-upgrade-pi') report.upgrade_payment_intent_identifier = 'pi_other';
    if (kind === 'report-alias') report.payment_intent_identifier = 'pi_other';
    if (kind === 'confirmation-ref') confirmation.checkoutIdentifier = 'oaics_paid_original';
    if (kind === 'confirmation-digest') confirmation.quoteDigest = '0'.repeat(64);
    if (kind === 'unsupported') f.job.result.current_plan_before = 'free';
    if (kind === 'unknown' || kind === 'requires_action') report.payment_status = kind;
    await closeOfficialTerminalFailure(
      f.tx as never,
      f.repository as never,
      f.job as never,
      report
    );
    expect(f.job.result[TERMINAL_FAILURE_KEY]).toBeUndefined();
    expect(f.repository.closeOfficialDeclinedRecords).not.toHaveBeenCalled();
  });

  it('升级旧attempt按原upg授权与唯一审计恢复，不拿原订阅checkout替代', async () => {
    const f = fixture(),
      upgrade = {
        operation: 'subscription_upgrade',
        upgrade_identifier: `upg_${'2'.repeat(32)}`,
        current_plan_before: 'go',
        target_plan: 'plus',
        quote_authority: 'official_upgrade_preview'
      };
    Object.assign(f.job.result, upgrade, { current_plan: 'go' });
    delete f.job.result.checkout_identifier;
    await f.authorize(upgrade);
    delete f.job.result[CARD_ATTEMPT_KEY];
    delete (f.job.result._direct_confirmation_v1 as Record<string, unknown>).consumedAt;
    f.audits.push({
      createdAt: new Date(),
      afterData: {
        checkoutIdentifier: upgrade.upgrade_identifier,
        quoteDigest: f.job.result.quote_digest
      }
    });
    expect(await recoverRechargeCardAttempt(f.tx as never, f.job as never, f.cards)).toMatchObject({
      outcome: 'pending',
      cardId
    });
    delete f.job.result[CARD_ATTEMPT_KEY];
    (f.job.result._direct_confirmation_v1 as Record<string, unknown>).checkoutIdentifier =
      'oaics_paid_original';
    expect(
      await recoverRechargeCardAttempt(f.tx as never, f.job as never, f.cards)
    ).toBeUndefined();
  });

  it.each(['unknown', 'requires_action', 'missing-binding'])(
    '官网%s不得自动解除原账号防重，期限仅释放卡独占',
    async (kind) => {
      const f = fixture();
      await f.authorize();
      f.job.result.payment_status = kind === 'missing-binding' ? 'declined' : kind;
      vi.setSystemTime(new Date(Date.now() + 120001));
      await f.pool.options('plus');
      expect(f.job.result[TERMINAL_FAILURE_KEY]).toBeUndefined();
      expect(rechargeAvailability(f.job as never, []).accountPaymentRestricted).toBe(true);
      expect(f.card.leaseOwner).toBeNull();
    }
  );

  it.each([false, true])(
    '人工核实结束及alreadyResolved补偿declined=%s仅释放原lease，结算不重复',
    async (declined) => {
      const f = fixture();
      await f.authorize();
      vi.setSystemTime(new Date(Date.now() + 120001));
      await f.pool.options('plus');
      f.card.leaseOwner = 'new-job';
      if (declined) f.job.result.payment_status = 'declined';
      for (let i = 0; i < 2; i++)
        await settleResolvedRechargeCard(f.tx as never, f.job as never, f.cards);
      expect(f.card).toMatchObject({
        leaseOwner: 'new-job',
        successCount: 0,
        declineCount: declined ? 1 : 0
      });
      expect(f.job.result[CARD_ATTEMPT_KEY]).toMatchObject({
        outcome: declined ? 'declined' : 'resolved'
      });
    }
  );

  it('pending原尝试未结算前不能删除legacy资料破坏既有索引归属', async () => {
    const f = fixture();
    await f.authorize();
    vi.setSystemTime(new Date(Date.now() + 120001));
    await f.pool.options('plus');
    await expect(f.pool.removeLegacyData(f.tx as never, f.card.numberHash)).rejects.toThrow('历史');
  });

  it.each([true, false])('共享options锁忙A继续B=%s，其他数据库错误不能吞掉', async (busy) => {
    const f = fixture();
    vi.stubEnv('DATABASE_URL', 'mysql://unit.invalid/only');
    const next = { ...f.card, id: '33333333-3333-4333-8333-333333333333', leaseOwner: null };
    f.card.leaseOwner = null;
    f.tx.onlineRechargeCard.findMany.mockResolvedValueOnce([f.card, next]);
    f.tx.$queryRaw
      .mockRejectedValueOnce(
        Object.assign(new Error('synthetic'), busy ? { errno: 3572 } : { code: 'P1001' })
      )
      .mockResolvedValueOnce([]);
    if (busy)
      expect((await f.pool.options('plus')).items.map((item) => item.id)).toEqual([next.id]);
    else await expect(f.pool.options('plus')).rejects.toThrow('核对');
  });

  it('旧已人工resolved但仍占卡的任务补偿为settled，不重新占未决额度', async () => {
    const f = fixture();
    await f.authorize();
    delete f.job.result[CARD_ATTEMPT_KEY];
    Object.assign(f.job.result, {
      operator_resolution: 'confirmed_no_bank_request',
      resolution_job_id: '55555555-5555-4555-8555-555555555555'
    });
    await reconcileRechargePaymentHolds({
      tx: f.tx as never,
      repository: f.repository as never,
      cards: f.cards,
      audit: f.audit as never,
      ownerId: owner.id
    });
    expect(f.card.leaseOwner).toBeNull();
    expect(f.job.result[CARD_ATTEMPT_KEY]).toMatchObject({ outcome: 'resolved' });
    expect(f.job.result.payment_attempted).toBe(true);
    expect(f.job.result.payment_requests_sent).toBe(1);
    expect((await f.pool.options('plus')).items).toHaveLength(1);
  });

  it('真实command manager的连续无变更读取不增版本或发布，实际释放只通知一次', async () => {
    const f = fixture();
    await f.authorize();
    const versions = { upsert: vi.fn(async () => ({})) };
    const tx = { ...f.tx, idBusinessV2ScopeVersion: versions };
    const publisher = { publishCommittedChangeBestEffort: vi.fn() };
    const manager = new V2CommandTransactionManager(
      { $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx) } as never,
      publisher as never
    );
    const pool = new SharedBankCardRepository({} as never, {} as never, manager, f.audit as never);
    const cards = new BankRechargeCardService(
      {} as never,
      {} as never,
      manager,
      f.audit as never,
      {} as never,
      pool
    );
    for (let i = 0; i < 2; i++) {
      await pool.options('plus');
      await cards.reconcilePaymentHolds(f.repository as never, owner as never);
    }
    expect(versions.upsert).not.toHaveBeenCalled();
    expect(publisher.publishCommittedChangeBestEffort).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(Date.now() + 120001));
    await pool.options('plus');
    expect(versions.upsert).toHaveBeenCalledTimes(2);
    expect(publisher.publishCommittedChangeBestEffort).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 2; i++) {
      await pool.options('plus');
      await cards.reconcilePaymentHolds(f.repository as never, owner as never);
    }
    expect(versions.upsert).toHaveBeenCalledTimes(2);
    expect(publisher.publishCommittedChangeBestEffort).toHaveBeenCalledTimes(1);
  });

  it('普通finished缺失本次明确intent/计数不得从历史补出自动终态证明', async () => {
    const f = fixture();
    await f.authorize();
    await f.service.callback(
      sourceId,
      {
        type: 'progress',
        result: { payment_intent_identifier: 'pi_bound', stage: 'payment_result' }
      },
      { localToken: 'synthetic-agent' }
    );
    await f.service.callback(
      sourceId,
      {
        type: 'finished',
        result: { status: 'payment_failed', stage: 'payment_result', payment_status: 'declined' }
      },
      { localToken: 'synthetic-agent' }
    );
    expect(f.job.result[TERMINAL_FAILURE_KEY]).toBeUndefined();
    expect(f.repository.closeOfficialDeclinedRecords).not.toHaveBeenCalled();
    expect(rechargeAvailability(f.job as never, []).accountPaymentRestricted).toBe(true);
  });
});
