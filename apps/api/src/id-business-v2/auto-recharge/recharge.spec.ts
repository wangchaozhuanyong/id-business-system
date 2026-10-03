import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { RechargeService } from './recharge.service';
import { RechargeRepository } from './persistence/recharge.repository';
import {
  confirmationNonce,
  hash,
  safeDocument,
  validateDetailsSubmission,
  validateStart
} from './recharge-validation';

const id = '11111111-1111-4111-8111-111111111111';
const operator = {
  id: 'admin-test',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
const input = () => ({
  id,
  sessionJson: '{"sessionToken":"synthetic"}',
  action: 'check',
  plan: 'plus'
});
const addressId = '22222222-2222-4222-8222-222222222222';
const paymentDetails = {
  number: '5555555555554444',
  expiry: '12/39',
  cvc: '123',
  name: 'Test User',
  email: 'test@example.invalid',
  country: 'MY',
  line1: 'Untrusted input',
  line2: 'Untrusted input',
  city: 'Untrusted city',
  state: 'Untrusted state',
  postal_code: '00000'
};
const prepareInput = () => ({
  ...input(),
  action: 'prepare' as const,
  addressId,
  details: { ...paymentDetails }
});
const amount = { amount: '92.50', amount_minor: 9250, currency: 'MYR' };
const zero = { amount: '0.00', amount_minor: 0, currency: 'MYR' };
const quote = {
  plan: 'plus' as const,
  today: amount,
  tax: zero,
  renewal: amount,
  renewal_interval: 'monthly' as const,
  tax_status: 'unknown',
  source: 'official_checkout_visible_text'
};

describe('recharge input and durable evidence', () => {
  it.each([null, 0, 1])('取消清理保留历史，只停用未发送确认的本套餐记录（%s）', async (sent) => {
    const accountKey = 'a'.repeat(64);
    const checkout = {
      accountKey,
      ownerId: operator.id,
      fileKey: `${accountKey}.json`,
      document: { checkout_identifier: 'cs_cancelled', payment_status: 'not_attempted' }
    };
    const payment = {
      accountKey,
      ownerId: operator.id,
      fileKey: `payments/${'b'.repeat(64)}.json`,
      document: {
        checkout_identifier: 'cs_cancelled',
        payment_status: 'unknown',
        payment_attempted: true,
        confirmation_requests_sent: sent
      }
    };
    const unrelated = {
      ...payment,
      fileKey: `payments/${'c'.repeat(64)}.json`,
      document: {
        ...payment.document,
        checkout_identifier: 'cs_other',
        confirmation_requests_sent: 1
      }
    };
    const records = {
      findUnique: vi.fn().mockResolvedValue(checkout),
      findMany: vi.fn().mockResolvedValue([checkout, payment, unrelated]),
      update: vi.fn()
    };
    const repository = new RechargeRepository({} as never);
    const retired = await repository.retireCancelledCheckout(
      { idBusinessV2RechargeRecord: records } as never,
      accountKey,
      'plus',
      operator.id
    );
    expect(retired).toBe(sent === 0 ? 2 : 0);
    expect(records.update).toHaveBeenCalledTimes(sent === 0 ? 2 : 0);
    for (const [change] of records.update.mock.calls) {
      expect(change.where.accountKey_fileKey.fileKey).not.toBe(unrelated.fileKey);
      expect(change.data.document.cancelled_before_confirmation).toBe(true);
      expect(change.data.revision).toEqual({ increment: 1 });
    }
  });

  it('无付款标记的取消结算自动停用，原订单及账单历史保留', async () => {
    const accountKey = 'a'.repeat(64);
    const checkout = {
      ownerId: operator.id,
      fileKey: `${accountKey}.json`,
      document: { checkout_identifier: 'cs_cancelled', payment_status: 'not_attempted' }
    };
    const records = {
      findUnique: vi.fn().mockResolvedValue(checkout),
      findMany: vi.fn().mockResolvedValue([checkout]),
      update: vi.fn()
    };
    const repository = new RechargeRepository({} as never);
    expect(
      await repository.retireCancelledCheckout(
        { idBusinessV2RechargeRecord: records } as never,
        accountKey,
        'plus',
        operator.id
      )
    ).toBe(1);
    expect(records.update.mock.calls[0][0].data.document).toMatchObject({
      checkout_identifier: 'cs_cancelled',
      checkout_outcome: 'cancelled',
      payment_attempted: false
    });
  });
  it('只保留范围内的会话进度与脱敏错误', () => {
    const progress = {
      session_attempt: 2,
      session_attempt_limit: 3,
      session_elapsed_seconds: 115,
      session_wait_seconds: 120,
      session_step: 'page_refresh',
      session_refresh_count: 1,
      quote_elapsed_seconds: 120,
      quote_wait_seconds: 120,
      quote_refresh_count: 1,
      page_state: 'blank',
      stale_profiles_cleaned: 2,
      error_type: 'TimeoutError',
      browser_error_code: 'net::ERR_TIMED_OUT'
    };
    expect(safeDocument({ ...progress, rawError: 'private', sessionJson: 'private' })).toEqual(
      progress
    );
    expect(
      safeDocument({
        session_attempt: 4,
        session_attempt_limit: 0,
        session_elapsed_seconds: -1,
        session_wait_seconds: 601,
        session_step: 'private',
        session_refresh_count: 2,
        quote_elapsed_seconds: 601,
        quote_wait_seconds: 59,
        quote_refresh_count: 2,
        page_state: 'private',
        stale_profiles_cleaned: 31
      })
    ).toEqual({});
  });
  it('保留独立代理重试进度，不放宽原会话预算或记录代理秘密', () => {
    expect(
      safeDocument({
        proxy_attempt: 10,
        proxy_attempt_limit: 10,
        proxy_wait_seconds: 20,
        session_attempt: 4,
        session_wait_seconds: 20,
        proxyUrl: 'private',
        proxyPassword: 'private'
      })
    ).toEqual({ proxy_attempt: 10, proxy_attempt_limit: 10, proxy_wait_seconds: 20 });
    expect(
      safeDocument({ proxy_attempt: 1, proxy_attempt_limit: 1, proxy_wait_seconds: 20 })
    ).toEqual({ proxy_attempt: 1, proxy_attempt_limit: 1, proxy_wait_seconds: 20 });
    for (const value of [0, 11, 1.5, '1'])
      expect(safeDocument({ proxy_attempt: value })).toEqual({});
    for (const value of [0, 2, 11, '10'])
      expect(safeDocument({ proxy_attempt_limit: value })).toEqual({});
    for (const value of [19, 21, '20'])
      expect(safeDocument({ proxy_wait_seconds: value })).toEqual({});
  });
  it('只保留受控的付款失败原因', () => {
    expect(safeDocument({ payment_failure_reason: 'insufficient_funds' })).toEqual({
      payment_failure_reason: 'insufficient_funds'
    });
    expect(safeDocument({ payment_failure_reason: 'card=private' })).toEqual({});
  });
  it('preserves only bounded selection diagnostics across the API boundary', () => {
    const diagnostics = {
      step: 'pricing_page',
      error_type: 'TimeoutError',
      role: 'link',
      matched_count: 0,
      enabled: false,
      available_plans: ['plus', 'pro-5x']
    };
    expect(
      safeDocument({
        diagnostics: {
          ...diagnostics,
          html: 'private',
          message: 'sessionToken=private',
          cvc: '123'
        }
      })
    ).toEqual({ diagnostics });
    expect(
      safeDocument({
        diagnostics: {
          step: 'sessionToken',
          matched_count: -1,
          enabled: 'true',
          available_plans: ['private', 'plus', 'plus']
        }
      })
    ).toEqual({ diagnostics: { available_plans: ['plus'] } });
  });
  it.each(['plus', 'pro-500'] as const)(
    'keeps controlled %s quote and original-order fields',
    (plan) => {
      const tierQuote = { ...quote, plan };
      expect(
        safeDocument({
          quote: { ...tierQuote, plan_source: 'official_checkout_selected_radio' },
          initial_quote: { ...tierQuote, today: null, tax: null },
          quote_authority: 'official_checkout_response',
          recheck_plan: plan,
          checkout_identifier: 'cs_original_synthetic',
          sessionJson: 'secret',
          cvc: 'secret',
          accessToken: 'secret'
        })
      ).toEqual({
        quote: tierQuote,
        initial_quote: { ...tierQuote, today: null, tax: null },
        quote_authority: 'official_checkout_response',
        recheck_plan: plan,
        checkout_identifier: 'cs_original_synthetic'
      });
      expect(safeDocument({ recheck_plan: 'other' })).toEqual({});
    }
  );
  it('does not turn an unknown amount into zero', () => {
    expect(
      (safeDocument({ quote: { ...quote, today: null } }).quote as typeof quote).today
    ).toBeNull();
    expect(() =>
      safeDocument({ quote: { ...quote, today: { ...amount, amount: 'NaN' } } })
    ).toThrow();
  });
  it('rejects card fields on a read-only operation and oversized JSON', () => {
    expect(() => validateStart({ ...input(), details: { cvc: '123' } })).toThrow();
    expect(() => validateStart({ ...input(), sessionJson: 'x'.repeat(65001) })).toThrow();
    expect(() => validateStart({ ...input(), plan: 'other' })).toThrow();
    expect(() => validateStart({ ...input(), action: 'flow' })).not.toThrow();
    expect(() => validateStart({ ...prepareInput(), addressId: undefined })).toThrow(
      '请选择未使用'
    );
    expect(() => validateStart(prepareInput())).not.toThrow();
    expect(() =>
      validateDetailsSubmission({ addressId, details: { ...paymentDetails } })
    ).not.toThrow();
    expect(() =>
      validateDetailsSubmission({ addressId, details: { ...paymentDetails, extra: 'private' } })
    ).toThrow();
  });
  it.each(['go', 'plus', 'pro-500'])('%s 服务器任务必须限定单次付款与上限', (plan) => {
    const server = {
      ...prepareInput(),
      plan,
      action: 'server',
      lockedCurrency: 'MYR',
      maxAmount: '100.00',
      authorizeSinglePayment: true,
      proxyId: id,
      proxyCountryCode: 'MY'
    };
    expect(() => validateStart(server)).not.toThrow();
    expect(() => validateStart({ ...server, maxAmount: undefined })).not.toThrow();
    expect(() => validateStart({ ...server, authorizeSinglePayment: false })).toThrow();
    expect(() => validateStart({ ...server, maxAmount: '0' })).toThrow();
    expect(() => validateStart({ ...server, proxy: { host: '127.0.0.1' } })).toThrow();
    expect(() => validateStart({ ...server, proxyCountryCode: 'US' })).not.toThrow();
    expect(() => validateStart({ ...server, proxyCountryCode: undefined })).toThrow();
    expect(() => validateStart({ ...server, proxyId: id, proxyCountryCode: 'usa' })).toThrow();
    expect(() => validateStart({ ...server, safety: { maxAmountMinor: 999999 } })).toThrow();
    const manual = {
      ...server,
      sessionJson: undefined,
      addressId: undefined,
      manualAddress: true,
      login: { email: paymentDetails.email, password: 'synthetic-password' }
    };
    expect(() => validateStart(manual)).not.toThrow();
    expect(() => validateStart({ ...manual, sessionJson: '{}' })).toThrow('请选择一种');
    expect(() =>
      validateStart({ ...manual, login: undefined, chatgptAccountId: id })
    ).not.toThrow();
    expect(() => validateStart({ ...manual, details: { ...paymentDetails, city: '' } })).toThrow();
  });
  it('refuses stale durable record writes', async () => {
    const previous = { revision: 2, ownerId: 'admin-test' };
    const tx = {
      idBusinessV2RechargeRecord: {
        findUnique: vi.fn().mockResolvedValue(previous),
        upsert: vi.fn()
      }
    };
    const repo = new RechargeRepository({} as never);
    await expect(
      repo.saveRecord(tx as never, {
        accountKey: 'a'.repeat(64),
        fileKey: 'record',
        revision: 1,
        document: {},
        ownerId: 'admin-test'
      })
    ).rejects.toThrow('版本冲突');
    expect(tx.idBusinessV2RechargeRecord.upsert).not.toHaveBeenCalled();
  });
  it('allows only an explicitly marked replacement of an unpaid checkout', async () => {
    const previous = {
      revision: 2,
      ownerId: 'admin-test',
      document: {
        checkout_identifier: 'cs_expired',
        payment_status: 'not_attempted',
        checkout_outcome: 'created'
      }
    };
    const tx = {
      idBusinessV2RechargeRecord: {
        findUnique: vi.fn().mockResolvedValue(previous),
        upsert: vi.fn().mockResolvedValue({})
      }
    };
    const repo = new RechargeRepository({} as never);
    const replacement = {
      status: 'checkout_attempted',
      stage: 'checkout_create',
      checkout_outcome: 'unknown',
      payment_status: 'not_attempted',
      retry_of: 'b'.repeat(64)
    };
    const input = {
      accountKey: 'a'.repeat(64),
      fileKey: 'a'.repeat(64) + '.json',
      revision: 2,
      document: replacement,
      ownerId: 'admin-test'
    };
    await expect(repo.saveRecord(tx as never, input)).rejects.toThrow('不可更换');
    await expect(
      repo.saveRecord(tx as never, { ...input, allowCheckoutReplacement: true })
    ).resolves.toEqual({ revision: 3 });
  });
  it('原子处理准确的未知付款与结账记录，并保留原确认计数', async () => {
    const accountKey = 'a'.repeat(64);
    const checkoutIdentifier = 'oaics_historical';
    const checkout = {
      accountKey,
      ownerId: operator.id,
      fileKey: `${accountKey}-pro-20x.json`,
      document: {
        checkout_identifier: checkoutIdentifier,
        target_plan: 'pro-20x',
        payment_status: 'not_attempted',
        payment_attempted: false,
        confirmation_requests_sent: 0
      }
    };
    const payment = {
      accountKey,
      ownerId: operator.id,
      fileKey: `payments/${'b'.repeat(64)}.json`,
      document: {
        account_key: accountKey,
        checkout_identifier: checkoutIdentifier,
        target_plan: 'pro-20x',
        payment_status: 'unknown',
        payment_attempted: true,
        confirmation_requests_sent: 1
      }
    };
    const update = vi.fn();
    const tx = {
      idBusinessV2RechargeRecord: {
        findMany: vi.fn().mockResolvedValue([checkout, payment]),
        update
      }
    };
    const repository = new RechargeRepository({} as never);
    await expect(
      repository.resolveUnknownPaymentRecords(tx as never, {
        accountKey,
        checkoutIdentifier,
        plan: 'pro-20x',
        ownerId: operator.id,
        resolutionJobId: id,
        sourceJobId: '33333333-3333-4333-8333-333333333333',
        verificationJobId: '44444444-4444-4444-8444-444444444444',
        resolvedAt: '2026-09-13T13:00:00.000Z'
      })
    ).resolves.toEqual({ updated: 2 });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0]![0].data.document).toMatchObject({
      operator_resolution: 'confirmed_no_bank_request',
      payment_status: 'not_attempted'
    });
    expect(update.mock.calls[1]![0].data.document).toMatchObject({
      operator_resolution: 'confirmed_no_bank_request',
      payment_attempted: true,
      confirmation_requests_sent: 1,
      payment_status: 'unknown'
    });
  });
});

describe('single worker dispatch and confirmation', () => {
  const tx = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    user: { findUnique: vi.fn() },
    idBusinessV2RechargeJob: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    idBusinessV2RechargeRecord: {
      findMany: vi.fn()
    }
  };
  const repository = new RechargeRepository({} as never);
  vi.spyOn(repository, 'lock');
  const active = vi.spyOn(repository, 'active');
  const list = vi.spyOn(repository, 'list');
  const transaction = { execute: vi.fn() };
  const audit = { append: vi.fn() };
  const addressRepository = {
    requireUnused: vi.fn(),
    markUsed: vi.fn()
  };
  let service: RechargeService;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(repository.lock).mockResolvedValue();
    vi.stubEnv('AUTO_RECHARGE_WORKER_TOKEN', 'x'.repeat(64));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    transaction.execute.mockImplementation(async (callback) => callback(tx));
    tx.$executeRaw.mockResolvedValue(1);
    tx.$queryRaw.mockResolvedValue([]);
    tx.user.findUnique.mockResolvedValue({ status: 'active', deletedAt: null });
    tx.idBusinessV2RechargeJob.findUnique.mockResolvedValue(null);
    tx.idBusinessV2RechargeJob.findFirst.mockResolvedValue(null);
    tx.idBusinessV2RechargeJob.findMany.mockResolvedValue([]);
    tx.idBusinessV2RechargeRecord.findMany.mockResolvedValue([]);
    tx.idBusinessV2RechargeJob.create.mockResolvedValue({ id });
    addressRepository.requireUnused.mockResolvedValue({
      id: addressId,
      country: 'US',
      line1: '1221 SW Fourth Avenue',
      city: 'Portland',
      state: 'OR',
      postalCode: '97204',
      status: 'unused'
    });
    addressRepository.markUsed.mockResolvedValue({
      changed: true,
      before: { status: 'unused' },
      after: { status: 'used' }
    });
    service = new RechargeService(
      repository as never,
      addressRepository as never,
      transaction as never,
      audit as never
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it.each(
    ['plus', 'pro-5x', 'pro-20x', 'pro-500'].flatMap((plan) =>
      ['', 'payments/'].map((prefix) => ({ plan, prefix }))
    )
  )('当前档位的建单和付款记录都能通过持久化回调：$plan / $prefix', async ({ plan, prefix }) => {
    const accountKey = 'a'.repeat(64);
    const fileKey = `${prefix}${accountKey}${plan === 'plus' ? '' : `-${plan}`}.json`;
    active.mockResolvedValue({
      id,
      ownerId: operator.id,
      accountKey,
      plan,
      action: 'server',
      state: 'confirming',
      result: {}
    } as never);
    const save = vi.spyOn(repository, 'saveRecord').mockResolvedValueOnce({ revision: 1 } as never);
    await expect(
      service.callback(id, {
        type: 'ledger',
        accountKey,
        fileKey,
        revision: 0,
        document: { target_plan: plan }
      })
    ).resolves.toEqual({ revision: 1 });
    expect(save).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ fileKey, accountKey, revision: 0 })
    );
  });
  it.each(['../', 'payments/../', '/payments/'])(
    '最高档回调继续拒绝越界路径：%s',
    async (prefix) => {
      const accountKey = 'a'.repeat(64);
      active.mockResolvedValue({
        id,
        ownerId: operator.id,
        accountKey,
        plan: 'pro-500',
        action: 'server',
        state: 'confirming',
        result: {}
      } as never);
      const save = vi.spyOn(repository, 'saveRecord');
      await expect(
        service.callback(id, {
          type: 'ledger',
          accountKey,
          fileKey: `${prefix}${accountKey}-pro-500.json`,
          revision: 0,
          document: {}
        })
      ).rejects.toThrow('原订单记录无效');
      expect(save).not.toHaveBeenCalled();
    }
  );

  it('会话等待进度续期，结束事件不续期', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
    const now = Date.now();
    active.mockResolvedValue({ id, action: 'bitbrowser', state: 'running', result: {} } as never);
    await service.callback(id, {
      type: 'progress',
      result: { stage: 'session_restore', session_elapsed_seconds: 110 }
    });
    const changed = tx.idBusinessV2RechargeJob.update.mock.calls.at(-1)![0].data;
    expect(changed.leaseUntil.getTime()).toBe(now + 45 * 60000);
    expect(changed.result.session_elapsed_seconds).toBe(110);
    await service.callback(id, {
      type: 'finished',
      result: { status: 'blocked', reason: 'session_retries_exhausted' }
    });
    expect(tx.idBusinessV2RechargeJob.update.mock.calls.at(-1)![0].data).not.toHaveProperty(
      'leaseUntil'
    );
  });
  it.each(['proxy_verifying', 'proxy_retrying'])(
    '服务器从 %s 进入登录只续期一次，迟到代理回执也不能重复续期',
    async (stage) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
      const current = {
        id,
        action: 'server',
        state: 'running',
        nonceHash: null,
        leaseUntil: new Date(Date.now() + 21 * 60000),
        result: { stage, recheck_only: true, source_job_id: addressId } as Record<string, unknown>
      };
      active.mockImplementation(async () => current as never);
      tx.idBusinessV2RechargeJob.update.mockImplementation(async ({ data }) => {
        Object.assign(current, data);
        return current;
      });
      vi.setSystemTime(new Date(Date.now() + 19 * 60000));
      const handoffTime = Date.now();
      await service.callback(id, {
        type: 'progress',
        result: { stage: 'session_restore', server_business_lease_started: false }
      });
      expect(current.leaseUntil.getTime()).toBe(handoffTime + 16 * 60000);
      expect(current.result).toMatchObject({
        stage: 'session_restore',
        server_business_lease_started: true,
        recheck_only: true,
        source_job_id: addressId
      });
      expect(current.state).toBe('running');
      expect(current.nonceHash).toBeNull();
      for (const nextStage of [
        'session_restore',
        'login_begin',
        'checkout_create',
        'payment_submit',
        stage,
        'session_restore'
      ]) {
        vi.setSystemTime(new Date(Date.now() + 60000));
        await service.callback(id, {
          type: 'progress',
          result: { stage: nextStage, server_business_lease_started: false }
        });
        const data = tx.idBusinessV2RechargeJob.update.mock.calls.at(-1)![0].data;
        expect(data).not.toHaveProperty('leaseUntil');
        expect(current.leaseUntil.getTime()).toBe(handoffTime + 16 * 60000);
        expect(current.result.server_business_lease_started).toBe(true);
      }
    }
  );
  it('服务器已结束、已确认或结束事件均不续期，非交接阶段也不续期', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
    const current = {
      id,
      action: 'server',
      state: 'finished',
      nonceHash: 'existing-confirmation',
      result: { stage: 'proxy_verifying' }
    };
    active.mockResolvedValue(current as never);
    await expect(
      service.callback(id, { type: 'progress', result: { stage: 'session_restore' } })
    ).rejects.toThrow('已结束');
    await service.callback(id, { type: 'finished', result: { stage: 'session_restore' } });
    expect(tx.idBusinessV2RechargeJob.update).not.toHaveBeenCalled();
    current.state = 'confirming';
    await service.callback(id, { type: 'progress', result: { stage: 'session_restore' } });
    let data = tx.idBusinessV2RechargeJob.update.mock.calls.at(-1)![0].data;
    expect(data).not.toHaveProperty('leaseUntil');
    expect(data.state).toBe('confirming');
    expect(data.nonceHash).toBe('existing-confirmation');
    current.state = 'running';
    current.result.stage = 'proxy_resolving';
    await service.callback(id, { type: 'progress', result: { stage: 'session_restore' } });
    data = tx.idBusinessV2RechargeJob.update.mock.calls.at(-1)![0].data;
    expect(data).not.toHaveProperty('leaseUntil');
    current.result.stage = 'proxy_verifying';
    await service.callback(id, {
      type: 'finished',
      result: { stage: 'session_restore', status: 'blocked' }
    });
    expect(tx.idBusinessV2RechargeJob.update.mock.calls.at(-1)![0].data).not.toHaveProperty(
      'leaseUntil'
    );
  });
  it('网页直连登录回传复用任务权限协议并保留模式，不保存秘密或触发付款记录', async () => {
    const result = { mode: 'open_browser', transport: 'web_direct', payment_requests_sent: 0 };
    active.mockResolvedValue({
      id,
      ownerId: operator.id,
      action: 'bitbrowser',
      state: 'running',
      result
    } as never);
    await service.callback(id, {
      type: 'progress',
      result: {
        stage: 'login_code_required',
        status: 'running',
        payment_requests_sent: 0,
        password: 'fixture-only-password',
        token: 'fixture-only-code'
      }
    });
    let changed = tx.idBusinessV2RechargeJob.update.mock.calls.at(-1)![0].data;
    expect(changed.state).toBe('awaiting_human_verification');
    expect(changed.result).toMatchObject({ ...result, stage: 'login_code_required' });
    expect(changed.result).not.toHaveProperty('password');
    expect(changed.result).not.toHaveProperty('token');
    await service.callback(id, {
      type: 'finished',
      result: {
        status: 'session_ready',
        stage: 'session_ready',
        account_matched: true,
        current_plan: 'free',
        payment_attempted: false,
        payment_requests_sent: 0
      }
    });
    changed = tx.idBusinessV2RechargeJob.update.mock.calls.at(-1)![0].data;
    expect(changed.state).toBe('finished');
    expect(changed.nonceHash).toBeNull();
    expect(changed.result).toMatchObject({
      ...result,
      account_matched: true,
      status: 'session_ready'
    });
  });
  it('恢复时只返回同操作人同账号且付款前失败的历史窗口，并幂等记录清理', async () => {
    const accountKey = 'a'.repeat(64);
    const sourceJobId = '33333333-3333-4333-8333-333333333333';
    const profileId = 'b'.repeat(32);
    const current = {
      id,
      ownerId: operator.id,
      accountKey: null as string | null,
      action: 'bitbrowser',
      state: 'running',
      result: {}
    };
    const stale = {
      id: sourceJobId,
      ownerId: operator.id,
      accountKey,
      state: 'finished',
      result: {
        reason: 'actual_quote_unknown',
        browser_profile_id: profileId,
        payment_status: 'not_attempted',
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0
      }
    };
    const unsafe = {
      ...stale,
      id: '44444444-4444-4444-8444-444444444444',
      result: { ...stale.result, browser_profile_id: 'c'.repeat(32), payment_requests_sent: 1 }
    };
    active.mockResolvedValue(current as never);
    tx.idBusinessV2RechargeJob.findMany.mockResolvedValue([stale, unsafe]);
    await expect(service.callback(id, { type: 'restore', accountKey })).resolves.toEqual({
      records: [],
      staleProfiles: [{ sourceJobId, profileId }]
    });

    current.accountKey = accountKey;
    active.mockResolvedValue(current as never);
    await expect(
      service.callback(id, {
        type: 'stale_profile_cleanup',
        accountKey,
        profiles: [{ sourceJobId, profileId }]
      })
    ).resolves.toEqual({ ok: true, updated: 1 });
    expect(tx.idBusinessV2RechargeJob.update).toHaveBeenCalledWith({
      where: { id: sourceJobId },
      data: {
        result: expect.objectContaining({
          browser_cleanup_status: 'completed',
          stale_cleanup_job_id: id
        })
      }
    });
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'id_business_v2.auto_recharge.stale_browser_cleanup',
        objectId: id
      })
    );

    tx.idBusinessV2RechargeJob.findMany.mockResolvedValue([
      { ...stale, result: { ...stale.result, browser_cleanup_status: 'completed' } }
    ]);
    await expect(
      service.callback(id, {
        type: 'stale_profile_cleanup',
        accountKey,
        profiles: [{ sourceJobId, profileId }]
      })
    ).resolves.toEqual({ ok: true, updated: 0 });
  });
  it('persists the job and audit before sending exactly one worker command', async () => {
    await service.start(input(), operator);
    expect(tx.idBusinessV2RechargeJob.create).toHaveBeenCalledOnce();
    expect(audit.append).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(tx.idBusinessV2RechargeJob.create.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fetch).mock.invocationCallOrder[0]!
    );
    expect(JSON.stringify(tx.idBusinessV2RechargeJob.create.mock.calls)).not.toContain('synthetic');
  });
  it.each(['check', 'prepare'])('原 %s 任务初始期限仍为 16 分钟', async (action) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
    await service.start(action === 'check' ? input() : prepareInput(), operator);
    expect(tx.idBusinessV2RechargeJob.create.mock.calls.at(-1)![0].data.leaseUntil.getTime()).toBe(
      Date.now() + 16 * 60000
    );
  });
  it('服务器新任务初始期限覆盖 20 分钟代理准备并保留一分钟回执缓冲', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
    const accounts = {
      requireCurrency: vi.fn().mockResolvedValue({ minorUnits: 2 }),
      encryptExpectedEmail: vi.fn().mockReturnValue('fixture-encrypted-email'),
      loginNetworkGuard: vi.fn().mockResolvedValue(null)
    };
    const addresses = {
      ...addressRepository,
      requireAvailable: vi.fn().mockResolvedValue({
        id: addressId,
        country: 'US',
        line1: '1221 SW Fourth Avenue',
        city: 'Portland',
        state: 'OR',
        postalCode: '97204'
      })
    };
    const settings = { requirePaymentCap: vi.fn().mockResolvedValue('100.00') };
    const proxies = {
      forCharge: vi.fn().mockResolvedValue({
        id,
        mode: 'dynamic',
        type: 'http',
        extractionUrl: 'https://proxy.example.invalid/fixture'
      })
    };
    tx.idBusinessV2RechargeJob.create.mockImplementationOnce(async ({ data }) => data);
    const serverService = new RechargeService(
      repository as never,
      addresses as never,
      transaction as never,
      audit as never,
      accounts as never,
      undefined,
      settings as never,
      undefined,
      proxies as never
    );
    await serverService.start(
      {
        ...prepareInput(),
        action: 'server',
        proxyId: id,
        proxyCountryCode: 'US',
        lockedCurrency: 'MYR',
        maxAmount: '100.00',
        authorizeSinglePayment: true
      },
      operator
    );
    const data = tx.idBusinessV2RechargeJob.create.mock.calls.at(-1)![0].data;
    expect(data.leaseUntil.getTime()).toBe(Date.now() + 21 * 60000);
    expect(data.result).toMatchObject({
      locked_currency: 'MYR',
      max_amount_minor: 10000,
      expected_proxy_country: 'US',
      mode: 'server'
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('repeated request id returns the original task without redispatch', async () => {
    tx.idBusinessV2RechargeJob.findUnique.mockResolvedValue({
      id,
      ownerId: operator.id,
      plan: 'plus',
      action: 'check'
    });
    await expect(service.start(input(), operator)).resolves.toEqual({ id });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a deleted employee before creating or dispatching a recharge job', async () => {
    tx.user.findUnique.mockResolvedValueOnce({ status: 'disabled', deletedAt: new Date() });
    await expect(service.start(input(), operator)).rejects.toThrow('员工账号已停用或删除');
    expect(tx.idBusinessV2RechargeJob.create).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not dispatch while another job is running or after a database failure', async () => {
    tx.idBusinessV2RechargeJob.findFirst.mockResolvedValue({ id: 'other' });
    await expect(service.start(input(), operator)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    transaction.execute.mockRejectedValueOnce(new Error('database offline'));
    await expect(service.start(input(), operator)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('任务列表只向符合条件的历史付款关联同账号 Free 核验记录', async () => {
    const sourceJobId = '33333333-3333-4333-8333-333333333333';
    const verificationJobId = '44444444-4444-4444-8444-444444444444';
    const accountKey = 'a'.repeat(64);
    const leaseUntil = new Date('2026-09-20T00:00:00Z');
    list.mockResolvedValue([
      {
        id: verificationJobId,
        ownerId: operator.id,
        accountKey,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'finished',
        nonceHash: null,
        leaseUntil,
        createdAt: new Date('2026-09-13T00:00:00Z'),
        updatedAt: new Date('2026-09-13T00:00:00Z'),
        result: {
          account_matched: true,
          current_plan: 'free',
          payment_attempted: false,
          payment_requests_sent: 0
        }
      },
      {
        id: sourceJobId,
        ownerId: operator.id,
        accountKey,
        plan: 'pro-20x',
        action: 'prepare',
        state: 'finished',
        nonceHash: null,
        leaseUntil,
        createdAt: new Date('2026-09-09T00:00:00Z'),
        updatedAt: new Date('2026-09-09T00:00:00Z'),
        result: {
          status: 'payment_result_unknown',
          checkout_identifier: 'oaics_historical',
          payment_attempted: true,
          confirmation_requests_sent: 0,
          payment_requests_sent: 1,
          payment_status: 'unknown'
        }
      }
    ] as never);
    const response = await service.list(operator);
    expect(response.items.find((job) => job.id === sourceJobId)?.result).toMatchObject({
      resolution_verification_job_id: verificationJobId
    });
    expect(response.items.every((job) => job.accountKey === undefined)).toBe(true);
  });
  it('does not retry unknown worker acceptance', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('timeout'));
    await expect(service.start(input(), operator)).rejects.toThrow('不会自动重发');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(
      1
    );
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.method).toBeUndefined();
  });
  it('loads the selected unused address and sends only the fixed location to the worker', async () => {
    await service.start(prepareInput(), operator);
    expect(addressRepository.requireUnused).toHaveBeenCalledWith(tx, operator.id, addressId);
    expect(tx.idBusinessV2RechargeJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ result: { addressId } })
    });
    const workerBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(workerBody.addressId).toBeUndefined();
    expect(workerBody.details).toMatchObject({
      country: 'US',
      line1: '1221 SW Fourth Avenue',
      line2: '',
      city: 'Portland',
      state: 'OR',
      postal_code: '97204'
    });
    expect(JSON.stringify(workerBody.details)).not.toContain('Untrusted');
  });
  it('does not dispatch when the selected address is no longer unused', async () => {
    addressRepository.requireUnused.mockRejectedValueOnce(new Error('address unavailable'));
    await expect(service.start(prepareInput(), operator)).rejects.toThrow('address unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('accepts payment details only for the waiting flow and never persists secrets', async () => {
    active.mockResolvedValue({
      id,
      ownerId: operator.id,
      plan: 'plus',
      action: 'flow',
      state: 'awaiting_details',
      result: { initial_quote: quote }
    } as never);
    const submitted = { addressId, details: { ...paymentDetails } };
    await service.submitDetails(id, submitted, operator);
    expect(addressRepository.requireUnused).toHaveBeenCalledWith(tx, operator.id, addressId);
    expect(tx.idBusinessV2RechargeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id } })
    );
    expect(JSON.stringify(tx.idBusinessV2RechargeJob.update.mock.calls)).not.toContain(
      paymentDetails.number
    );
    const workerBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(workerBody.details).toMatchObject({
      number: paymentDetails.number,
      country: 'US',
      line1: '1221 SW Fourth Avenue',
      city: 'Portland',
      state: 'OR',
      postal_code: '97204'
    });
    expect(submitted.details.number).toBe('');
  });
  it('reserves confirmation before dispatch and rejects repeated/stale confirmations', async () => {
    const nonce = confirmationNonce(id, quote, 'x'.repeat(64));
    const job = {
      id,
      ownerId: operator.id,
      state: 'awaiting_confirmation',
      nonceHash: hash(nonce),
      result: { quote }
    };
    active.mockResolvedValue(job as never);
    tx.idBusinessV2RechargeJob.update.mockImplementation(async () => {
      job.state = 'confirming';
    });
    await service.confirm(id, nonce, operator);
    await expect(service.confirm(id, nonce, operator)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('reconstructs the same confirmation credential after an API restart', async () => {
    const nonce = confirmationNonce(id, quote, 'x'.repeat(64));
    list.mockResolvedValue([
      {
        id,
        ownerId: operator.id,
        plan: 'plus',
        action: 'flow',
        state: 'awaiting_confirmation',
        nonceHash: hash(nonce),
        accountKey: 'a'.repeat(64),
        result: { quote, quote_authority: 'official_checkout_response' },
        leaseUntil: new Date(Date.now() + 60000),
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ] as never);
    service = new RechargeService(
      repository as never,
      addressRepository as never,
      transaction as never,
      audit as never
    );
    const result = await service.list(operator);
    expect(result.items[0]?.result).toMatchObject({ nonce });
  });
  it('ends an unknown confirmation receipt immediately without resending', async () => {
    const nonce = confirmationNonce(id, quote, 'x'.repeat(64));
    const job = {
      id,
      ownerId: operator.id,
      plan: 'plus',
      action: 'flow',
      state: 'awaiting_confirmation',
      nonceHash: hash(nonce),
      result: { quote, quote_authority: 'official_checkout_response' }
    };
    active.mockResolvedValue(job as never);
    tx.idBusinessV2RechargeJob.findUnique.mockResolvedValue(job);
    tx.idBusinessV2RechargeJob.update.mockImplementation(async ({ data }) => {
      Object.assign(job, data);
      return job;
    });
    vi.mocked(fetch).mockRejectedValue(new Error('timeout'));
    await expect(service.confirm(id, nonce, operator)).rejects.toThrow('只能刷新或复查');
    expect(vi.mocked(fetch).mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(
      1
    );
    expect(job.state).toBe('unknown');
    expect(tx.idBusinessV2RechargeJob.update).toHaveBeenLastCalledWith({
      where: { id },
      data: expect.objectContaining({ state: 'unknown', leaseUntil: expect.any(Date) })
    });
  });
  it('refuses confirmation callbacks without explicit tax and official order authority', async () => {
    active.mockResolvedValue({
      id,
      ownerId: operator.id,
      plan: 'plus',
      action: 'flow',
      state: 'running',
      nonceHash: null,
      result: {}
    } as never);
    const incomplete = { ...quote, tax: null };
    await expect(
      service.callback(id, {
        type: 'confirmation',
        result: {
          quote: incomplete,
          quote_authority: 'official_checkout_response',
          nonce: confirmationNonce(id, incomplete, 'x'.repeat(64))
        }
      })
    ).rejects.toThrow('最终报价不完整');
  });
  it('rejects worker calls without the independent secret', () => {
    expect(() => service.authorizeWorker('bad')).toThrow();
    expect(() => service.authorizeWorker('x'.repeat(64))).not.toThrow();
  });
  it('marks the selected address used at the first real payment request and not after safe failure', async () => {
    const job = {
      id,
      ownerId: operator.id,
      accountKey: 'a'.repeat(64),
      action: 'flow',
      state: 'confirming',
      nonceHash: null,
      result: { addressId }
    };
    active.mockResolvedValue(job as never);
    await service.callback(id, {
      type: 'finished',
      result: {
        status: 'payment_result_unknown',
        payment_status: 'unknown',
        payment_attempted: true,
        confirmation_requests_sent: 1,
        payment_requests_sent: 1
      }
    });
    expect(addressRepository.markUsed).toHaveBeenCalledWith(tx, operator.id, addressId, id);
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'id_business_v2.auto_recharge.addresses.consume',
        objectId: addressId
      })
    );

    vi.clearAllMocks();
    active.mockResolvedValue({ ...job, result: { addressId } } as never);
    transaction.execute.mockImplementation(async (callback) => callback(tx));
    await service.callback(id, {
      type: 'finished',
      result: { status: 'blocked', payment_status: 'not_attempted', payment_requests_sent: 0 }
    });
    expect(addressRepository.markUsed).not.toHaveBeenCalled();
  });
  it('marks a BitBrowser address used from the durable marker before the payment request', async () => {
    active.mockResolvedValue({
      id,
      ownerId: operator.id,
      accountKey: 'a'.repeat(64),
      action: 'bitbrowser',
      state: 'running',
      nonceHash: hash('local-agent-token'),
      result: { addressId }
    } as never);
    vi.spyOn(repository, 'saveRecord').mockResolvedValueOnce({ revision: 1 } as never);

    await service.callback(id, {
      type: 'ledger',
      accountKey: 'a'.repeat(64),
      fileKey: `payments/${'a'.repeat(64)}.json`,
      revision: 0,
      document: {
        schema_version: 3,
        stage: 'payment_request_sending',
        payment_attempted: true,
        confirmation_requests_sent: 1,
        payment_status: 'unknown'
      }
    });

    expect(addressRepository.markUsed).toHaveBeenCalledWith(tx, operator.id, addressId, id);
  });

  it('只读复查即使看到历史付款标记也不消耗新地址', async () => {
    active.mockResolvedValue({
      id,
      ownerId: operator.id,
      accountKey: 'a'.repeat(64),
      action: 'bitbrowser',
      state: 'running',
      nonceHash: hash('local-agent-token'),
      result: { recheck_only: true }
    } as never);

    await service.callback(id, {
      type: 'finished',
      result: {
        status: 'payment_result_unknown',
        recheck_only: true,
        payment_attempted: true,
        payment_requests_sent: 1
      }
    });

    expect(addressRepository.markUsed).not.toHaveBeenCalled();
  });

  it('连接器处理未知付款时原子更新记录、原任务和审计，不消费地址', async () => {
    const sourceJobId = '33333333-3333-4333-8333-333333333333';
    const verificationJobId = '44444444-4444-4444-8444-444444444444';
    const accountKey = 'a'.repeat(64);
    const source = {
      id: sourceJobId,
      ownerId: operator.id,
      accountKey,
      plan: 'pro-20x',
      action: 'prepare',
      state: 'finished',
      createdAt: new Date('2026-09-09T00:00:00Z'),
      result: {
        status: 'payment_result_unknown',
        checkout_identifier: 'oaics_historical',
        payment_attempted: true,
        confirmation_requests_sent: 0,
        payment_requests_sent: 1,
        payment_status: 'unknown'
      }
    };
    const verification = {
      id: verificationJobId,
      ownerId: operator.id,
      accountKey,
      plan: 'plus',
      action: 'bitbrowser',
      state: 'finished',
      createdAt: new Date('2026-09-13T00:00:00Z'),
      result: {
        account_matched: true,
        current_plan: 'free',
        payment_attempted: false,
        confirmation_requests_sent: 0,
        payment_requests_sent: 0
      }
    };
    active.mockResolvedValue({
      id,
      ownerId: operator.id,
      accountKey,
      plan: 'pro-20x',
      action: 'bitbrowser',
      state: 'running',
      nonceHash: hash('local-agent-token'),
      result: {
        resolution_only: true,
        source_job_id: sourceJobId,
        verification_job_id: verificationJobId,
        checkout_identifier: 'oaics_historical'
      }
    } as never);
    tx.idBusinessV2RechargeJob.findUnique.mockImplementation(({ where }) =>
      where.id === sourceJobId ? source : where.id === verificationJobId ? verification : null
    );
    const resolveRecords = vi
      .spyOn(repository, 'resolveUnknownPaymentRecords')
      .mockResolvedValueOnce({ updated: 2 });

    await service.callback(id, {
      type: 'resolve_unknown_payment',
      plan: 'pro-20x',
      accountKey,
      checkoutIdentifier: 'oaics_historical',
      sourceJobId,
      verificationJobId
    });

    expect(resolveRecords).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        accountKey,
        checkoutIdentifier: 'oaics_historical',
        sourceJobId,
        verificationJobId
      })
    );
    expect(tx.idBusinessV2RechargeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: sourceJobId },
        data: expect.objectContaining({
          result: expect.objectContaining({
            payment_attempted: true,
            confirmation_requests_sent: 0,
            payment_requests_sent: 1,
            operator_resolution: 'confirmed_no_bank_request'
          })
        })
      })
    );
    expect(addressRepository.markUsed).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'id_business_v2.auto_recharge.payment_resolution.complete',
        objectId: sourceJobId
      })
    );
    resolveRecords.mockRestore();
  });

  it('停止确认回调先停用取消结算，再结束任务并写审计', async () => {
    active.mockResolvedValue({
      id,
      ownerId: operator.id,
      accountKey: 'a'.repeat(64),
      plan: 'plus',
      action: 'bitbrowser',
      state: 'running',
      result: { status: 'cancelling' }
    } as never);
    const retire = vi.spyOn(repository, 'retireCancelledCheckout').mockResolvedValueOnce(1);
    await service.callback(id, {
      type: 'finished',
      result: {
        status: 'cancelled',
        cancellation_confirmed: true,
        payment_requests_sent: 0,
        payment_attempted: false,
        browser_cleanup_status: 'completed'
      }
    });
    expect(retire).toHaveBeenCalledWith(tx, 'a'.repeat(64), 'plus', operator.id);
    expect(tx.idBusinessV2RechargeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'finished', nonceHash: null })
      })
    );
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'id_business_v2.auto_recharge.bitbrowser.cancel',
        afterData: { retiredRecords: 1, browserCleanup: 'completed' }
      })
    );
  });

  it.each([
    ['flow', false, true],
    ['bitbrowser', false, true],
    ['bitbrowser', true, false]
  ])('旧结算替换仅开放给自动执行，复查保持只读（%s/%s）', async (action, recheckOnly, allowed) => {
    active.mockResolvedValue({
      id,
      ownerId: operator.id,
      accountKey: 'a'.repeat(64),
      plan: 'plus',
      action,
      state: 'running',
      result: { recheck_only: recheckOnly }
    } as never);
    const save = vi.spyOn(repository, 'saveRecord').mockResolvedValueOnce({ revision: 2 });
    await service.callback(id, {
      type: 'ledger',
      accountKey: 'a'.repeat(64),
      fileKey: `${'a'.repeat(64)}.json`,
      revision: 1,
      document: { status: 'checkout_attempted' }
    });
    expect(save).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ allowCheckoutReplacement: allowed })
    );
  });
});
