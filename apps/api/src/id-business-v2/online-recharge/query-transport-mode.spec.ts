import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { OnlineRechargeOperation } from './contracts';
import { OnlineRechargeTasksRepository } from './persistence/tasks.repository';
import { OnlineRechargeTasksService } from './tasks.service';
import { assertQueryTransportModeInput } from './validation';

const administrator: AuthenticatedUser = {
  id: 'fixture-admin',
  username: 'fixture-admin',
  displayName: '合成管理员',
  roles: ['admin'],
  permissions: []
};
const manager: AuthenticatedUser = {
  ...administrator,
  id: 'fixture-manager',
  roles: ['employee'],
  permissions: ['id_business_v2.online_recharge.manage']
};
const session = JSON.stringify({
  accessToken: 'synthetic-session-not-a-real-credential',
  user: { id: 'fixture-user', email: 'fixture@example.test' }
});

function fixture() {
  const repository = {
    start: vi.fn(async () => ({ id: 'fixture-task', operation: 'subscription' })),
    action: vi.fn(async () => ({ tasks: [{ id: 'fixture-task', operation: 'subscription' }] }))
  };
  return {
    repository,
    service: new OnlineRechargeTasksService(repository as unknown as OnlineRechargeTasksRepository)
  };
}

describe('管理员独立订阅网络对照入口', () => {
  it.each([
    { session, queryTransportMode: 'transport_compare' },
    {
      id: '11111111-1111-4111-8111-111111111111',
      version: 3,
      queryTransportMode: 'transport_compare'
    },
    { session, queryTransportMode: 'transport_compare', action: 'check' }
  ])('只透传已授权的会话管理查询，不直接创建或重排充值', async (input) => {
    const f = fixture();
    await f.service.action('sessions', 'subscription', input, administrator);
    expect(f.repository.action).toHaveBeenCalledExactlyOnceWith(
      'sessions',
      'subscription',
      input,
      administrator
    );
    expect(f.repository.start).not.toHaveBeenCalled();
  });

  it('有管理权限的非管理员仍不能开启网络对照', () => {
    const f = fixture();
    expect(() =>
      f.service.action(
        'sessions',
        'subscription',
        { session, queryTransportMode: 'transport_compare' },
        manager
      )
    ).toThrow('网络对照仅允许管理员执行');
    expect(f.repository.action).not.toHaveBeenCalled();
  });

  it.each([null, undefined, false, true, '', 'standard', 'page', [], {}])(
    '显式无效网络对照选项不进入任务处理：%j',
    (mode) => {
      const f = fixture();
      expect(() =>
        f.service.action(
          'sessions',
          'subscription',
          { session, queryTransportMode: mode },
          administrator
        )
      ).toThrow('网络对照仅支持独立订阅查询');
      expect(f.repository.action).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['jobs', 'start'],
    ['jobs', 'subscription'],
    ['jobs', 'recheck'],
    ['checkout-debug', 'start'],
    ['renewal', 'check'],
    ['renewal', 'enable'],
    ['sessions', 'reveal'],
    ['sessions', 'export']
  ])('其他入口 %s/%s 拒绝网络对照属性', (section, action) => {
    const f = fixture();
    expect(() =>
      f.service.action(
        section,
        action,
        { id: 'fixture-task', queryTransportMode: 'transport_compare' },
        administrator
      )
    ).toThrow('网络对照仅支持独立订阅查询');
    expect(f.repository.action).not.toHaveBeenCalled();
  });

  it.each([
    'recheckTaskId',
    'recheckedByTaskId',
    'originalOperation',
    'originalProvider',
    'sourceVersion',
    'renewalAction',
    'paymentLimit',
    'paymentContext',
    'paymentStarted',
    'confirmedPaid',
    'checkoutRecovery',
    'checkoutRecoveryVersion',
    'checkoutRecoveryEncrypted',
    'checkoutId',
    'checkoutUrl',
    'providerOrderId',
    'providerTaskId',
    'cardId',
    'cardLast4',
    'cardNumber',
    'cvc',
    'cvv',
    'code'
  ])('携带原单或付款字段 %s 时拒绝，空值也不能绕过', (key) => {
    const f = fixture();
    expect(() =>
      f.service.action(
        'sessions',
        'subscription',
        { session, queryTransportMode: 'transport_compare', [key]: null },
        administrator
      )
    ).toThrow('不能携带原单或付款资料');
    expect(f.repository.action).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'recheck' },
    { action: 'enable' },
    { action: undefined },
    { operation: 'recharge' },
    { operation: 'renewal' }
  ])('不能通过隐藏操作参数改变独立查询语义', (extra) => {
    const f = fixture();
    expect(() =>
      f.service.action(
        'sessions',
        'subscription',
        { session, queryTransportMode: 'transport_compare', ...extra },
        administrator
      )
    ).toThrow('网络对照仅支持独立订阅查询');
    expect(f.repository.action).not.toHaveBeenCalled();
  });

  it.each(['recharge', 'debug', 'subscription', 'renewal'] as OnlineRechargeOperation[])(
    '公共或直接创建 %s 不接受网络对照属性，即使调用身份为管理员',
    (operation) => {
      const f = fixture();
      for (const operator of [undefined, administrator, manager]) {
        expect(() =>
          f.service.start({ session, queryTransportMode: 'transport_compare' }, operator, operation)
        ).toThrow('网络对照仅支持管理员在会话管理中发起');
      }
      expect(f.repository.start).not.toHaveBeenCalled();
    }
  );

  it('经销商直接创建也不能用诊断属性改变任务行为', () => {
    const f = fixture();
    expect(() =>
      f.service.start(
        { session, queryTransportMode: 'transport_compare' },
        administrator,
        'recharge',
        true,
        'fixture-dealer'
      )
    ).toThrow('网络对照仅支持管理员在会话管理中发起');
    expect(f.repository.start).not.toHaveBeenCalled();
  });

  it('未传诊断选项的普通查询和原有未知字段保持既有透传', async () => {
    const f = fixture();
    const input = { session, existingUnknownField: 'fixture-unchanged' };
    await f.service.action('sessions', 'subscription', input, manager);
    expect(f.repository.action).toHaveBeenCalledExactlyOnceWith(
      'sessions',
      'subscription',
      input,
      manager
    );
    await f.service.start(input, administrator, 'subscription');
    expect(f.repository.start).toHaveBeenCalledExactlyOnceWith(
      input,
      administrator,
      'subscription',
      false,
      undefined
    );
  });
});

describe('任务仓储受理前共用网络对照保护', () => {
  it('共用保护允许仅管理员纯查询并精确返回受控模式', () => {
    expect(
      assertQueryTransportModeInput(
        {
          session,
          queryTransportMode: 'transport_compare',
          action: 'check',
          id: '11111111-1111-4111-8111-111111111111',
          version: 3,
          page: 1,
          pageSize: 20,
          keyword: '',
          status: '',
          plan: '',
          dispatched: '',
          sortOrder: 'desc',
          region: 'US',
          startDate: undefined,
          endDate: undefined
        },
        administrator,
        'subscription'
      )
    ).toBe('transport_compare');
  });

  it('默认未传模式时不改变其他入口或未知字段校验', () => {
    expect(
      assertQueryTransportModeInput(
        { session, paymentLimit: { currency: 'PHP', maxAmount: '9990' }, unknown: true },
        undefined,
        'recharge',
        'fixture-dealer'
      )
    ).toBeUndefined();
  });

  it.each([
    { field: 'unapprovedField', value: 'ignored-before' },
    { field: 'paymentLimitCurrency', value: '' },
    { field: 'paymentStarted', value: false },
    { field: 'confirmedPaid', value: false },
    { field: 'recheckTaskId', value: '' },
    { field: 'recheckedByTaskId', value: undefined },
    { field: 'cardId', value: null }
  ])('诊断模式拒绝任何非白名单字段：$field', ({ field, value }) => {
    expect(() =>
      assertQueryTransportModeInput(
        { session, queryTransportMode: 'transport_compare', [field]: value },
        administrator,
        'subscription'
      )
    ).toThrow('不能携带原单或付款资料');
  });

  it.each([
    { operator: undefined, operation: 'subscription' },
    { operator: manager, operation: 'subscription' },
    { operator: administrator, operation: 'recharge' },
    { operator: administrator, operation: 'debug' },
    { operator: administrator, operation: 'renewal' },
    { operator: administrator, operation: 'subscription', integrationSource: '' },
    { operator: administrator, operation: 'subscription', integrationSource: 'fixture-dealer' },
    { operator: administrator, operation: 'subscription', extra: { action: 'recheck' } },
    { operator: administrator, operation: 'subscription', extra: { recheckTaskId: '' } },
    { operator: administrator, operation: 'subscription', extra: { paymentLimit: null } },
    { operator: administrator, operation: 'subscription', extra: { cardId: undefined } },
    { operator: administrator, operation: 'subscription', extra: { queryTransportMode: true } }
  ] as {
    operator?: AuthenticatedUser;
    operation: OnlineRechargeOperation;
    integrationSource?: string;
    extra?: Record<string, unknown>;
  }[])('仓储在事务前阻断越权或变更用途：$operation', async (input) => {
    const database = { transaction: vi.fn(() => Promise.reject(new Error('不应进入数据库'))) };
    const repository = new OnlineRechargeTasksRepository(
      database as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    await expect(
      repository.start(
        { session, queryTransportMode: 'transport_compare', ...input.extra },
        input.operator,
        input.operation,
        false,
        input.integrationSource
      )
    ).rejects.toThrow('网络对照');
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
