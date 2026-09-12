import { describe, expect, it, vi } from 'vitest';
import { hash } from './recharge-validation';
import {
  validateRechargeBitBrowserRecheckStart,
  validateRechargeBitBrowserStart
} from './recharge-local-validation';
import { RechargeLocalService } from './recharge-local.service';
import { validateRechargeBitBrowserSettings } from './recharge-settings-validation';

const id = '11111111-1111-4111-8111-111111111111';
const addressId = '22222222-2222-4222-8222-222222222222';
const sourceJobId = '33333333-3333-4333-8333-333333333333';
const operator = {
  id: 'admin-test',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
const startInput = () => ({
  id,
  plan: 'plus',
  addressId,
  windowName: '申请gpt-001',
  lockedCurrency: 'USD',
  maxAmount: '30.00',
  authorizeSinglePayment: true
});

describe('比特浏览器充值输入边界', () => {
  it('将付款上限精确转为最小货币单位', () => {
    expect(validateRechargeBitBrowserStart(startInput())).toMatchObject({
      lockedCurrency: 'USD',
      maxAmount: '30.00',
      maxAmountMinor: 3000,
      authorizeSinglePayment: true
    });
    expect(
      validateRechargeBitBrowserStart({
        ...startInput(),
        lockedCurrency: 'JPY',
        maxAmount: '3000'
      })
    ).toMatchObject({ maxAmountMinor: 3000 });
  });

  it('拒绝未授权、错误币种精度和任何卡资料字段', () => {
    expect(() =>
      validateRechargeBitBrowserStart({ ...startInput(), authorizeSinglePayment: false })
    ).toThrow();
    expect(() =>
      validateRechargeBitBrowserStart({
        ...startInput(),
        lockedCurrency: 'JPY',
        maxAmount: '30.00'
      })
    ).toThrow();
    expect(() =>
      validateRechargeBitBrowserStart({ ...startInput(), cardNumber: '5555555555554444' })
    ).toThrow();
  });

  it('设置只允许本机接口且已存密钥可留空', () => {
    expect(
      validateRechargeBitBrowserSettings({
        connectorUrl: 'http://127.0.0.1:55321',
        localApiUrl: 'http://localhost:54345',
        groupName: 'gpt账号注册',
        tagName: '申请gpt',
        proxyType: 'http'
      })
    ).toMatchObject({ localApiToken: undefined, dynamicProxyUrl: undefined });
    expect(() =>
      validateRechargeBitBrowserSettings({
        connectorUrl: 'https://remote.example',
        localApiUrl: 'http://localhost:54345',
        groupName: 'gpt账号注册',
        tagName: '申请gpt',
        proxyType: 'http'
      })
    ).toThrow('本机 HTTP 地址');
  });

  it('只读复查只接受原任务和窗口信息', () => {
    expect(
      validateRechargeBitBrowserRecheckStart({
        id,
        sourceJobId,
        plan: 'plus',
        windowName: '原单复查-001'
      })
    ).toEqual({ id, sourceJobId, plan: 'plus', windowName: '原单复查-001' });
    expect(() =>
      validateRechargeBitBrowserRecheckStart({
        id,
        sourceJobId,
        plan: 'plus',
        windowName: '原单复查-001',
        cardNumber: '5555555555554444'
      })
    ).toThrow();
  });
});

describe('本机任务持久化边界', () => {
  it('生产 API 只保存脱敏任务，完整密钥只返回给当前操作者', async () => {
    const tx = {};
    const repository = {
      lock: vi.fn(),
      findJob: vi.fn().mockResolvedValue(null),
      findRunningJob: vi.fn().mockResolvedValue(null),
      createJob: vi.fn().mockImplementation((_tx, data) => ({ id: data.id }))
    };
    const addressRepository = {
      requireUnused: vi.fn().mockResolvedValue({
        id: addressId,
        line1: '1221 SW Fourth Avenue',
        country: 'US',
        city: 'Portland',
        state: 'OR',
        postalCode: '97204'
      })
    };
    const settings = {
      runtime: vi.fn().mockResolvedValue({
        connectorUrl: 'http://127.0.0.1:55321',
        connectorToken: 'c'.repeat(64),
        localApiUrl: 'http://127.0.0.1:54345',
        localApiToken: 'b'.repeat(32),
        groupName: 'gpt账号注册',
        tagName: '申请gpt',
        proxyType: 'http',
        dynamicProxyUrl: 'https://proxy.example/secret'
      })
    };
    const transactions = { execute: vi.fn((callback) => callback(tx)) };
    const audit = { append: vi.fn() };
    const service = new RechargeLocalService(
      repository as never,
      addressRepository as never,
      settings as never,
      { callback: vi.fn() } as never,
      transactions as never,
      audit as never
    );

    const result = await service.start(startInput(), operator);

    expect(repository.createJob).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'bitbrowser',
        state: 'running',
        result: expect.objectContaining({
          addressId,
          window_name: '申请gpt-001',
          locked_currency: 'USD',
          max_amount: '30.00',
          payment_requests_sent: 0
        })
      })
    );
    expect(JSON.stringify(repository.createJob.mock.calls)).not.toContain('proxy.example');
    expect(result).toMatchObject({
      connectorToken: 'c'.repeat(64),
      bitBrowser: { localApiToken: 'b'.repeat(32), dynamicProxyUrl: 'https://proxy.example/secret' }
    });
    expect(result.agentToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('回调密钥错误时不处理执行结果', async () => {
    const callback = vi.fn();
    const service = new RechargeLocalService(
      {
        byId: vi.fn().mockResolvedValue({
          action: 'bitbrowser',
          nonceHash: hash('a'.repeat(64))
        })
      } as never,
      {} as never,
      {} as never,
      { callback } as never,
      {} as never,
      {} as never
    );

    await expect(service.callback(id, 'wrong', { type: 'progress', result: {} })).rejects.toThrow(
      '连接凭据无效'
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it('只有未被本机接收的初始任务才能原子结束', async () => {
    const tx = {};
    const repository = {
      lock: vi.fn(),
      findJob: vi.fn().mockResolvedValue({
        id,
        ownerId: operator.id,
        action: 'bitbrowser',
        state: 'running',
        result: {
          status: 'waiting_local_connector',
          stage: 'connector_dispatch',
          payment_requests_sent: 0
        }
      }),
      updateJob: vi.fn()
    };
    const audit = { append: vi.fn() };
    const service = new RechargeLocalService(
      repository as never,
      {} as never,
      {} as never,
      {} as never,
      { execute: vi.fn((callback) => callback(tx)) } as never,
      audit as never
    );

    await service.abandonUnreceived(id, operator);

    expect(repository.updateJob).toHaveBeenCalledWith(
      tx,
      id,
      expect.objectContaining({
        state: 'finished',
        nonceHash: null,
        result: expect.objectContaining({
          reason: 'local_connector_not_received',
          payment_requests_sent: 0
        })
      })
    );
    expect(audit.append).toHaveBeenCalledOnce();

    repository.findJob.mockResolvedValueOnce({
      id,
      ownerId: operator.id,
      action: 'bitbrowser',
      state: 'running',
      result: { status: 'running', stage: 'bitbrowser_profile_opened', payment_requests_sent: 0 }
    });
    await expect(service.abandonUnreceived(id, operator)).rejects.toThrow('本机任务已接收或已开始');
  });

  it('只读复查不取地址、不接收付款资料并禁止复查任务再套娃', async () => {
    const tx = {};
    const repository = {
      lock: vi.fn(),
      findRunningJob: vi.fn().mockResolvedValue(null),
      findJob: vi.fn().mockImplementation((_tx, jobId) => {
        if (jobId === id) return null;
        return {
          id: sourceJobId,
          ownerId: operator.id,
          plan: 'plus',
          action: 'bitbrowser',
          result: { payment_attempted: true, payment_status: 'unknown' }
        };
      }),
      createJob: vi.fn().mockImplementation((_tx, data) => ({ id: data.id }))
    };
    const addressRepository = { requireUnused: vi.fn() };
    const settings = {
      runtime: vi.fn().mockResolvedValue({
        connectorUrl: 'http://127.0.0.1:55321',
        connectorToken: 'c'.repeat(64),
        localApiUrl: 'http://127.0.0.1:54345',
        localApiToken: 'b'.repeat(32),
        groupName: 'gpt账号注册',
        tagName: '申请gpt',
        proxyType: 'http',
        dynamicProxyUrl: 'https://proxy.example/secret'
      })
    };
    const service = new RechargeLocalService(
      repository as never,
      addressRepository as never,
      settings as never,
      { callback: vi.fn() } as never,
      { execute: vi.fn((callback) => callback(tx)) } as never,
      { append: vi.fn() } as never
    );

    const result = await service.recheck(
      { id, sourceJobId, plan: 'plus', windowName: '原单复查-001' },
      operator
    );

    expect(addressRepository.requireUnused).not.toHaveBeenCalled();
    expect(repository.createJob).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'bitbrowser',
        result: expect.objectContaining({ recheck_only: true, payment_requests_sent: 0 })
      })
    );
    expect(result).toMatchObject({
      mode: 'recheck',
      bitBrowser: { localApiToken: 'b'.repeat(32) }
    });

    repository.findJob.mockImplementation((_tx, jobId) =>
      jobId === id
        ? null
        : {
            id: sourceJobId,
            ownerId: operator.id,
            plan: 'plus',
            action: 'bitbrowser',
            result: { recheck_only: true, payment_attempted: true, payment_status: 'unknown' }
          }
    );
    await expect(
      service.recheck({ id, sourceJobId, plan: 'plus', windowName: '原单复查-002' }, operator)
    ).rejects.toThrow('该记录不能只读复查原订单');

    repository.findJob.mockImplementation((_tx, jobId) =>
      jobId === id
        ? null
        : {
            id: sourceJobId,
            ownerId: operator.id,
            plan: 'plus',
            action: 'bitbrowser',
            result: {
              status: 'subscription_activated',
              payment_attempted: true,
              payment_status: 'paid'
            }
          }
    );
    await expect(
      service.recheck({ id, sourceJobId, plan: 'plus', windowName: '已成功任务' }, operator)
    ).rejects.toThrow('该记录不能只读复查原订单');
  });
});
