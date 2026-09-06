import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { RechargeService } from './recharge.service';
import { RechargeRepository } from './persistence/recharge.repository';
import { hash, safeDocument, validateStart } from './recharge-validation';

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
const amount = { amount: '92.50', amount_minor: 9250, currency: 'MYR' };
const quote = {
  plan: 'plus',
  today: amount,
  tax: null,
  renewal: amount,
  renewal_interval: 'monthly',
  tax_status: 'unknown',
  source: 'official_checkout_visible_text'
};

describe('recharge input and durable evidence', () => {
  it('keeps a complete quote unchanged for the Python digest and removes credentials', () => {
    expect(
      safeDocument({ quote, sessionJson: 'secret', cvc: 'secret', accessToken: 'secret' })
    ).toEqual({ quote });
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
  const transaction = { execute: vi.fn() };
  const audit = { append: vi.fn() };
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
    service = new RechargeService(repository as never, transaction as never, audit as never);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('reserves confirmation before dispatch and rejects repeated/stale confirmations', async () => {
    const nonce = 'a'.repeat(64);
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
  it('rejects worker calls without the independent secret', () => {
    expect(() => service.authorizeWorker('bad')).toThrow();
    expect(() => service.authorizeWorker('x'.repeat(64))).not.toThrow();
  });
});
