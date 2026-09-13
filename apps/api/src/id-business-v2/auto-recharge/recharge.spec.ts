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
      session_step: 'account_read',
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
        session_step: 'private'
      })
    ).toEqual({});
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
  it('keeps controlled quote fields and removes credentials and legacy display metadata', () => {
    expect(
      safeDocument({
        quote: { ...quote, plan_source: 'official_checkout_selected_radio' },
        initial_quote: { ...quote, today: null, tax: null },
        quote_authority: 'official_checkout_response',
        recheck_plan: 'pro-20x',
        checkout_identifier: 'cs_original_synthetic',
        sessionJson: 'secret',
        cvc: 'secret',
        accessToken: 'secret'
      })
    ).toEqual({
      quote,
      initial_quote: { ...quote, today: null, tax: null },
      quote_authority: 'official_checkout_response',
      recheck_plan: 'pro-20x',
      checkout_identifier: 'cs_original_synthetic'
    });
    expect(safeDocument({ recheck_plan: 'other' })).toEqual({});
  });
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
});

describe('single worker dispatch and confirmation', () => {
  const tx = {
    idBusinessV2RechargeJob: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
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
    tx.idBusinessV2RechargeJob.findUnique.mockResolvedValue(null);
    tx.idBusinessV2RechargeJob.findFirst.mockResolvedValue(null);
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
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('会话等待进度续期，结束事件不续期', async () => {
    const now = Date.now();
    active.mockResolvedValue({ id, action: 'bitbrowser', state: 'running', result: {} } as never);
    await service.callback(id, {
      type: 'progress',
      result: { stage: 'session_restore', session_elapsed_seconds: 110 }
    });
    const changed = tx.idBusinessV2RechargeJob.update.mock.calls.at(-1)![0].data;
    expect(changed.leaseUntil.getTime()).toBeGreaterThanOrEqual(now + 45 * 60000);
    expect(changed.result.session_elapsed_seconds).toBe(110);
    await service.callback(id, {
      type: 'finished',
      result: { status: 'blocked', reason: 'session_retries_exhausted' }
    });
    expect(tx.idBusinessV2RechargeJob.update.mock.calls.at(-1)![0].data).not.toHaveProperty(
      'leaseUntil'
    );
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
  it('does not dispatch while another job is running or after a database failure', async () => {
    tx.idBusinessV2RechargeJob.findFirst.mockResolvedValue({ id: 'other' });
    await expect(service.start(input(), operator)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    transaction.execute.mockRejectedValueOnce(new Error('database offline'));
    await expect(service.start(input(), operator)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
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
    expect(addressRepository.markUsed).toHaveBeenCalledWith(tx, operator.id, addressId);
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

    expect(addressRepository.markUsed).toHaveBeenCalledWith(tx, operator.id, addressId);
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
