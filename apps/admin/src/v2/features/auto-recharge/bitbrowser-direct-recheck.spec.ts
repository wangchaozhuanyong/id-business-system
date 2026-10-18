import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedPaymentBrowser } from './bitbrowser-payment-session';
import type { V2RechargeBrowserRestore } from '@apple-business/shared';
import { runDirectPaymentRecheck } from './bitbrowser-direct-recheck';
const mock = vi.hoisted(() => ({ evaluate: vi.fn(), close: vi.fn(), persist: vi.fn() }));
vi.mock('./bitbrowser-payment-session', () => ({
  createDirectPaymentSession: async (browser: VerifiedPaymentBrowser) => ({
    session: { signal: browser.signal, evaluate: mock.evaluate },
    close: mock.close
  })
}));
vi.mock('./bitbrowser-direct-payment', () => ({
  directPlanMatches: (plan: string, current: string) => plan === current
}));
vi.mock('./bitbrowser-payment-evidence', async (original) => ({
  ...(await original<typeof import('./bitbrowser-payment-evidence')>()),
  officialPaymentRead: (_identity: unknown, path: string) => path
}));
const sid = 'oaics_SyntheticOriginal';
const upg = `upg_${'c'.repeat(32)}`;
const key = (value: string) => createHash('sha256').update(value).digest('hex');
const quote = {
  plan: 'plus',
  today: { amount_minor: 2000, currency: 'USD', amount: '20.00' },
  tax: { amount_minor: 0, currency: 'USD', amount: '0.00' },
  renewal: { amount_minor: 2000, currency: 'USD', amount: '20.00' },
  renewal_interval: 'monthly'
};
let restored: V2RechargeBrowserRestore;
let browser: VerifiedPaymentBrowser;
let original: Record<string, unknown>;
let invoices: Record<string, unknown>[];
let current: string;
beforeEach(() => {
  vi.resetAllMocks();
  current = 'plus';
  mock.persist.mockResolvedValue({ revision: 2 });
  invoices = [];
  browser = {
    signal: new AbortController().signal,
    identity: {
      accountId: 'synthetic-account',
      userId: 'synthetic-user',
      email: 'synthetic@example.test',
      plan: 'free'
    }
  } as VerifiedPaymentBrowser;
  restored = {
    records: [
      {
        fileKey: `payments/${key(sid)}.json`,
        revision: 1,
        document: {
          checkout_identifier: sid,
          processor_entity: 'openai_llc',
          quote,
          payment_attempted: true,
          account_key: key('synthetic-account'),
          target_plan: 'plus',
          payment_requests_sent: 1,
          confirmation_requests_sent: 1,
          status: 'payment_result_unknown',
          payment_status: 'unknown',
          quote_digest: 'a'.repeat(64),
          quote_authority: 'official_checkout_response',
          created_at: 1700000000,
          mode: 'payment',
          transport: 'official_browser'
        }
      }
    ],
    staleProfiles: []
  };
  original = {
    checkout_session_id: sid,
    processor_entity: 'openai_llc',
    plan_name: 'chatgptplusplan',
    payment_status: 'paid',
    checkout_state: { id: sid, currency: 'usd', total: { total: { minorUnitsAmount: 2000 } } }
  };
  mock.evaluate.mockImplementation(async (path: string) =>
    path.includes('/accounts/check/')
      ? {
          ok: true,
          data: {
            accounts: {
              'synthetic-account': {
                account: { account_id: 'synthetic-account', plan_type: current }
              }
            }
          }
        }
      : path.includes('/invoices?')
        ? { ok: true, data: { data: invoices } }
        : { ok: true, data: original }
  );
});
describe('网页只读复查原付款', () => {
  it.each([
    { reason: 'official_read_token_invalid', status: 401, expected: 'official_read_token_invalid' },
    { reason: 'official_read_timeout', status: 0, expected: 'official_read_timeout' },
    {
      reason: 'untrusted-private-message',
      status: 403,
      expected: 'direct_payment_existing_checkout_read_failed'
    }
  ])(
    '只读读取失败保留安全分类和状态，不保存响应正文：$expected',
    async ({ reason, status, expected }) => {
      mock.evaluate.mockResolvedValue({
        ok: false,
        status,
        reason,
        data: { secret: 'private-body' }
      });
      await expect(
        runDirectPaymentRecheck(
          browser,
          'plus',
          { checkout_identifier: sid },
          restored,
          mock.persist
        )
      ).rejects.toMatchObject({
        facts: {
          stage: 'original_payment_recheck',
          reason: expected,
          ...(status ? { http_status: status } : {})
        }
      });
      expect(mock.close).toHaveBeenCalledOnce();
      expect(mock.persist).not.toHaveBeenCalled();
    }
  );
  it('原单明确paid及目标订阅一致才确认开通，全程只有GET读取', async () => {
    const result = await runDirectPaymentRecheck(
      browser,
      'plus',
      { checkout_identifier: sid },
      restored,
      mock.persist
    );
    expect(result).toMatchObject({
      status: 'subscription_activated',
      payment_requests_sent: 0,
      confirmation_requests_sent: 0,
      recheck_only: true,
      payment_evidence: {
        kind: 'checkout_session',
        identifier: sid,
        amount_minor: 2000,
        currency: 'USD'
      }
    });
    expect(mock.evaluate.mock.calls.map(([path]) => path)).toEqual([
      '/backend-api/accounts/check/v4-2023-04-27',
      `/backend-api/payments/checkout/openai_llc/${sid}`
    ]);
    expect(mock.close).toHaveBeenCalledOnce();
    expect(mock.persist).toHaveBeenCalledOnce();
    expect(mock.persist.mock.calls[0]?.[0]).toMatchObject({
      type: 'ledger',
      accountKey: key('synthetic-account'),
      fileKey: `payments/${key(sid)}.json`,
      revision: 1,
      document: {
        status: 'subscription_activated',
        payment_status: 'paid',
        payment_requests_sent: 1,
        confirmation_requests_sent: 1,
        payment_attempted: true,
        account_key: key('synthetic-account'),
        target_plan: 'plus',
        quote,
        quote_digest: 'a'.repeat(64),
        quote_authority: 'official_checkout_response',
        created_at: 1700000000,
        mode: 'payment',
        transport: 'official_browser'
      }
    });
    expect(mock.persist.mock.calls[0]?.[0].document).not.toHaveProperty('recheck_only');
  });
  it('只有订阅已开通但原单unpaid仍未知，不能推断付款', async () => {
    original.payment_status = 'unpaid';
    const result = await runDirectPaymentRecheck(
      browser,
      'plus',
      { checkout_identifier: sid },
      restored,
      mock.persist
    );
    expect(result.status).toBe('payment_result_unknown');
    expect(result.payment_evidence).toBeUndefined();
    expect(mock.persist).not.toHaveBeenCalled();
  });
  it.each(['不同原单', '不同金额', '不同账号'])('%s拒绝，不改变任何订单', async (scenario) => {
    if (scenario === '不同原单') original.checkout_session_id = 'oaics_Other';
    else if (scenario === '不同金额')
      original.checkout_state = {
        id: sid,
        currency: 'USD',
        total: { total: { minorUnitsAmount: 2100 } }
      };
    else
      mock.evaluate.mockResolvedValue({
        ok: true,
        data: {
          accounts: { 'synthetic-account': { account: { account_id: 'other', plan_type: 'plus' } } }
        }
      });
    await expect(
      runDirectPaymentRecheck(browser, 'plus', { checkout_identifier: sid }, restored, mock.persist)
    ).rejects.toThrow();
    expect(mock.close).toHaveBeenCalledOnce();
  });
  it('升级只接受同原发票或同已持久PI绑定且实付金额一致的发票', async () => {
    restored.records = [
      {
        fileKey: `payments/${key(upg)}.json`,
        revision: 1,
        document: {
          operation: 'subscription_upgrade',
          account_key: key('synthetic-account'),
          target_plan: 'plus',
          payment_requests_sent: 1,
          confirmation_requests_sent: 1,
          upgrade_identifier: upg,
          upgrade_payment_intent_identifier: 'pi_Synthetic',
          quote,
          payment_attempted: true
        }
      }
    ];
    invoices = [
      {
        object: 'invoice',
        id: 'in_Other',
        payment_intent: 'pi_Other',
        status: 'paid',
        paid: true,
        amount_paid: 2000,
        currency: 'usd'
      }
    ];
    expect(
      (
        await runDirectPaymentRecheck(
          browser,
          'plus',
          { upgrade_identifier: upg },
          restored,
          mock.persist
        )
      ).payment_evidence
    ).toBeUndefined();
    invoices = [
      {
        object: 'invoice',
        id: 'in_Synthetic',
        payment_intent: 'pi_Synthetic',
        status: 'paid',
        paid: true,
        amount_paid: 2000,
        currency: 'usd'
      }
    ];
    expect(
      (
        await runDirectPaymentRecheck(
          browser,
          'plus',
          { upgrade_identifier: upg },
          restored,
          mock.persist
        )
      ).payment_evidence
    ).toEqual({ kind: 'invoice', identifier: 'in_Synthetic', amount_minor: 2000, currency: 'USD' });
    expect(mock.persist).toHaveBeenCalledOnce();
    expect(mock.persist.mock.calls[0]?.[0]).toMatchObject({
      fileKey: `payments/${key(upg)}.json`,
      revision: 1,
      document: {
        operation: 'subscription_upgrade',
        upgrade_identifier: upg,
        upgrade_payment_intent_identifier: 'pi_Synthetic',
        upgrade_invoice_identifier: 'in_Synthetic',
        payment_status: 'paid',
        payment_requests_sent: 1,
        confirmation_requests_sent: 1
      }
    });
  });
  it('已有发票绑定时同PI的另一张发票不能覆盖原发票', async () => {
    const prior = (restored.records[0] as { document: Record<string, unknown> }).document;
    const document: Record<string, unknown> = {
      ...prior,
      operation: 'subscription_upgrade',
      upgrade_identifier: upg,
      upgrade_payment_intent_identifier: 'pi_Synthetic',
      upgrade_invoice_identifier: 'in_Original'
    };
    delete document.checkout_identifier;
    restored.records = [{ fileKey: `payments/${key(upg)}.json`, revision: 1, document }];
    invoices = [
      {
        object: 'invoice',
        id: 'in_Other',
        payment_intent: 'pi_Synthetic',
        status: 'paid',
        paid: true,
        amount_paid: 2000,
        currency: 'usd'
      }
    ];
    expect(
      (
        await runDirectPaymentRecheck(
          browser,
          'plus',
          { upgrade_identifier: upg },
          restored,
          mock.persist
        )
      ).payment_evidence
    ).toBeUndefined();
    expect(mock.persist).not.toHaveBeenCalled();
    invoices.push({ ...invoices[0], id: 'in_Original' });
    const result = await runDirectPaymentRecheck(
      browser,
      'plus',
      { upgrade_identifier: upg },
      restored,
      mock.persist
    );
    expect(result.upgrade_invoice_identifier).toBe('in_Original');
    expect(mock.persist.mock.calls[0]?.[0].document.upgrade_invoice_identifier).toBe('in_Original');
  });
  it.each(['缺记录', '错误文件名', '缺报价', '重复记录', '不同账号'])(
    '%s时不能创建账本或宣告paid收尾',
    async (scenario) => {
      const row = restored.records[0] as { fileKey: string; document: Record<string, unknown> };
      if (scenario === '缺记录') restored.records = [];
      if (scenario === '错误文件名') row.fileKey = `payments/${key(JSON.stringify(sid))}.json`;
      if (scenario === '缺报价') delete row.document.quote;
      if (scenario === '重复记录') restored.records.push({ ...row });
      if (scenario === '不同账号') row.document.account_key = key('other-account');
      await expect(
        runDirectPaymentRecheck(
          browser,
          'plus',
          { checkout_identifier: sid, processor_entity: 'openai_llc', quote },
          restored,
          mock.persist
        )
      ).rejects.toThrow();
      expect(mock.persist).not.toHaveBeenCalled();
    }
  );
  it.each(['冲突', '无递增revision'])('账本CAS%s时保留未知，不返回paid收尾', async (scenario) => {
    if (scenario === '冲突') mock.persist.mockRejectedValue(new Error('原账本已变化'));
    else mock.persist.mockResolvedValue({ revision: 1 });
    await expect(
      runDirectPaymentRecheck(browser, 'plus', { checkout_identifier: sid }, restored, mock.persist)
    ).rejects.toThrow();
    expect(mock.persist).toHaveBeenCalledOnce();
  });
});
