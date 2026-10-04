import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startRechargeJob } from './recharge-start';
import { validateStart } from './recharge-validation';
import { sendRechargeWorkerRequest } from './recharge-worker-client';

vi.mock('./recharge-worker-client', () => ({
  isRechargeWorkerConfigured: () => true,
  sendRechargeWorkerRequest: vi.fn()
}));

const id = '11111111-1111-4111-8111-111111111111';
const addressId = '22222222-2222-4222-8222-222222222222';
const totpAccountId = '88888888-8888-4888-8888-888888888888';
const operator = {
  id: 'admin-test',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
const totp = {
  secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  algorithm: 'sha256' as const,
  digits: 8,
  period: 60
};
let dispatched: Record<string, unknown>;

function input() {
  return {
    id,
    action: 'server',
    plan: 'plus',
    addressId,
    proxyId: '33333333-3333-4333-8333-333333333333',
    proxyCountryCode: 'US',
    lockedCurrency: 'USD',
    authorizeSinglePayment: true,
    login: { email: 'test@example.invalid', password: 'synthetic-password', totpAccountId },
    details: {
      number: '5555555555554444',
      expiry: '12/39',
      cvc: '123',
      name: 'Test User',
      email: 'test@example.invalid',
      country: 'US',
      line1: '',
      line2: '',
      city: '',
      state: '',
      postal_code: ''
    }
  };
}

function dependencies() {
  const tx = {};
  const repository = {
    lock: vi.fn(),
    findJob: vi.fn().mockResolvedValue(null),
    findRunningJob: vi.fn().mockResolvedValue(null),
    createJob: vi.fn(async (_tx: unknown, data: object) => ({ ...data, id }))
  };
  return {
    tx,
    repository,
    addressRepository: {
      requireAvailable: vi.fn().mockResolvedValue({
        id: addressId,
        country: 'US',
        line1: '1221 SW Fourth Avenue',
        city: 'Portland',
        state: 'OR',
        postalCode: '97204'
      })
    },
    transactions: { execute: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(tx)) },
    audit: { append: vi.fn() },
    bankAccounts: {
      requireCurrency: vi.fn().mockResolvedValue({ minorUnits: 2 }),
      encryptExpectedEmail: vi.fn().mockReturnValue('encrypted'),
      loginNetworkGuard: vi.fn().mockResolvedValue(null)
    },
    bankCards: { checkAvailability: vi.fn() },
    settings: { requirePaymentCap: vi.fn().mockResolvedValue('30.00') },
    proxies: {
      forCharge: vi.fn().mockResolvedValue({
        id: 'proxy-id',
        mode: 'static',
        type: 'http',
        host: 'proxy.example.invalid',
        port: 8080,
        username: '',
        password: ''
      })
    },
    totpAccounts: { forExecution: vi.fn().mockResolvedValue({ ...totp }) },
    finishUnreceivedJob: vi.fn()
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dispatched = {};
  vi.mocked(sendRechargeWorkerRequest).mockImplementation(async (_path, body) => {
    dispatched = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    return 'accepted';
  });
});

describe('付款确认方式任务快照', () => {
  it.each([true, false, undefined])('人工开关 %s 持久化并传给同一执行器任务', async (mode) => {
    const deps = dependencies();
    const submitted = {
      ...input(),
      ...(mode === undefined ? {} : { manualPaymentConfirmation: mode })
    };
    await startRechargeJob(submitted, operator, deps as never);
    expect(deps.repository.createJob.mock.calls[0]![1]).toMatchObject({
      result: { manual_payment_confirmation: mode === true }
    });
    expect(dispatched.manualPaymentConfirmation).toBe(mode);
    expect(dispatched.safety).toMatchObject({
      authorizeSinglePayment: true,
      lockedCurrency: 'USD',
      maxAmountMinor: 3000
    });
  });
  it.each(['true', 1, null])('拒绝非布尔开关 %s', (mode) => {
    expect(() => validateStart({ ...input(), manualPaymentConfirmation: mode })).toThrow('开关值');
  });
  it('同一任务编号不能更换人工确认方式，也不能再次交付', async () => {
    const deps = dependencies();
    deps.repository.findJob.mockResolvedValue({
      id,
      ownerId: operator.id,
      plan: 'plus',
      action: 'server',
      result: { addressId, manual_payment_confirmation: true }
    } as never);
    await expect(
      startRechargeJob({ ...input(), manualPaymentConfirmation: false }, operator, deps as never)
    ).rejects.toThrow('确认方式');
    expect(sendRechargeWorkerRequest).not.toHaveBeenCalled();
  });
});

describe('服务器使用已保存 2FA', () => {
  it('按当前用户读取配置，仅向执行器内存传递且不写入任务或日志', async () => {
    const deps = dependencies();
    const submitted = input();
    await expect(startRechargeJob(submitted, operator, deps as never)).resolves.toEqual({ id });
    expect(deps.totpAccounts.forExecution).toHaveBeenCalledWith(deps.tx, totpAccountId, operator);
    expect(dispatched.login).toEqual({
      email: 'test@example.invalid',
      password: 'synthetic-password',
      totp
    });
    expect(dispatched.login).not.toHaveProperty('totpAccountId');
    expect(dispatched.login).not.toHaveProperty('totpSecret');
    for (const calls of [deps.repository.createJob.mock.calls, deps.audit.append.mock.calls]) {
      expect(JSON.stringify(calls)).not.toContain(totp.secret);
      expect(JSON.stringify(calls)).not.toContain('synthetic-password');
      expect(JSON.stringify(calls)).not.toContain('totpAccountId');
    }
    expect(submitted.login.password).toBe('');
    const delivered = vi.mocked(sendRechargeWorkerRequest).mock.calls[0]![1] as {
      login: { password: string; totp?: unknown };
    };
    expect(delivered.login.password).toBe('');
    expect(delivered.login.totp).toBeUndefined();
  });

  it('不存在或越权的 2FA 账号在建单和发送执行器前阻止任务', async () => {
    const deps = dependencies();
    deps.totpAccounts.forExecution.mockRejectedValueOnce(
      new NotFoundException('2FA 账号不存在或不属于当前用户')
    );
    await expect(startRechargeJob(input(), operator, deps as never)).rejects.toThrow(
      '不属于当前用户'
    );
    expect(deps.repository.createJob).not.toHaveBeenCalled();
    expect(sendRechargeWorkerRequest).not.toHaveBeenCalled();
  });

  it('系统取码服务不可用时不会忽略选择继续执行', async () => {
    const deps = dependencies();
    await expect(
      startRechargeJob(input(), operator, { ...deps, totpAccounts: undefined } as never)
    ).rejects.toThrow('系统 2FA 服务不可用');
    expect(deps.repository.createJob).not.toHaveBeenCalled();
    expect(sendRechargeWorkerRequest).not.toHaveBeenCalled();
  });

  it.each(['', 'invalid', 1])('拒绝无效 2FA 编号 %s', (value) => {
    const submitted = input();
    expect(() =>
      validateStart({ ...submitted, login: { ...submitted.login, totpAccountId: value } })
    ).toThrow('登录资料格式无效');
  });

  it('拒绝同时指定密钥和系统账号', () => {
    const submitted = input();
    expect(() =>
      validateStart({ ...submitted, login: { ...submitted.login, totpSecret: totp.secret } })
    ).toThrow('登录资料格式无效');
  });

  it('粘贴密钥也按执行器配置格式发送，不能混入 issuer 字段', async () => {
    const deps = dependencies();
    const submitted = input();
    const login = {
      email: submitted.login.email,
      password: submitted.login.password,
      totpSecret: `otpauth://totp/Test:user?secret=${totp.secret}&issuer=Test&algorithm=SHA256&digits=8&period=60`
    };
    await startRechargeJob({ ...submitted, login }, operator, deps as never);
    expect(dispatched.login).toEqual({
      email: 'test@example.invalid',
      password: 'synthetic-password',
      totp
    });
    expect(deps.totpAccounts.forExecution).not.toHaveBeenCalled();
  });
});

describe('服务器代理和账单国家独立', () => {
  it.each([
    ['PH', false],
    ['PH', true],
    ['JP', false],
    ['GB', false]
  ])('%s 代理搭配美国账单，手填地址=%s，分别传递至执行器', async (countryCode, manual) => {
    const deps = dependencies();
    const submitted = input();
    const address = {
      id: addressId,
      country: 'US',
      line1: '1221 SW Fourth Avenue',
      city: 'Portland',
      state: 'OR',
      postalCode: '97204'
    };
    const manualRepository = {
      ...deps.addressRepository,
      createOrReuseManual: vi.fn().mockResolvedValue({ address, created: false })
    };
    await startRechargeJob(
      {
        ...submitted,
        proxyCountryCode: countryCode,
        lockedCurrency: 'PHP',
        ...(manual ? { manualAddress: true, addressId: undefined } : {}),
        details: {
          ...submitted.details,
          line1: address.line1,
          city: address.city,
          state: address.state,
          postal_code: address.postalCode
        }
      },
      operator,
      { ...deps, addressRepository: manualRepository } as never
    );
    expect(dispatched.expectedCountry).toBe(countryCode);
    expect(dispatched.details).toMatchObject({ country: 'US', line1: address.line1 });
    expect(dispatched.safety).toMatchObject({
      lockedCurrency: 'PHP',
      authorizeSinglePayment: true
    });
    expect(deps.proxies.forCharge).toHaveBeenCalledWith(submitted.proxyId, operator, countryCode);
    expect(deps.bankAccounts.loginNetworkGuard).toHaveBeenCalledWith(
      deps.tx,
      submitted.details.email,
      countryCode
    );
    expect(manualRepository.createOrReuseManual).toHaveBeenCalledTimes(manual ? 1 : 0);
    expect(deps.addressRepository.requireAvailable).toHaveBeenCalledTimes(manual ? 0 : 1);
  });
});

describe('服务器已保存 Plus 升级按目标套餐核验', () => {
  it.each(['pro-5x', 'pro-20x', 'pro-500'])(
    '启动 %s 不能省略目标套餐或沿用 Plus 资格',
    async (plan) => {
      const deps = dependencies();
      const assertRechargeEligible = vi.fn().mockResolvedValue({ id: totpAccountId });
      const bankAccounts = {
        ...deps.bankAccounts,
        assertRechargeEligible,
        savedLogin: vi
          .fn()
          .mockReturnValue({ email: 'test@example.invalid', password: 'synthetic-password' })
      };
      await startRechargeJob(
        { ...input(), plan, login: undefined, chatgptAccountId: totpAccountId },
        operator,
        { ...deps, bankAccounts } as never
      );
      expect(assertRechargeEligible).toHaveBeenCalledWith(deps.tx, totpAccountId, plan);
      expect(dispatched.plan).toBe(plan);
    }
  );
});
