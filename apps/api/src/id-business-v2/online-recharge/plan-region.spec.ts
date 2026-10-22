import { describe, expect, it, vi } from 'vitest';
import { ONLINE_RECHARGE_DEFAULTS, type OnlineRechargePlan } from './contracts';
import {
  resolvePlanRegion,
  runtimePlanRegion,
  taskPlanRegion,
  validatePlanRegions
} from './plan-region';
import { OnlineRechargeTasksRepository } from './persistence/tasks.repository';
import { OnlineRechargeWorkerRpcRepository } from './persistence/worker-rpc.repository';

const operator = { id: 'fixture-operator', roles: ['admin'] } as never;
const taskId = '123e4567-e89b-42d3-a456-426614174001';
const session = JSON.stringify({
  accessToken: 'synthetic-fixture-session-value',
  user: { id: 'fixture' }
});
const encryption = {
  encrypt: (v: unknown) => v ?? null,
  decrypt: (v: unknown) => v ?? null,
  hash: (v: unknown) => v ?? null
};
const settings = {
  ...ONLINE_RECHARGE_DEFAULTS,
  proxyCountryCode: 'PH',
  planRegionRoutingEnabled: true
};
const expected = [
  ['plus', 'PH', 'PHP'],
  ['pro_5x', 'CL', 'CLP'],
  ['pro_20x', 'PH', 'PHP'],
  ['pro_500', 'CL', 'CLP']
] as const;

function fixture(overrides = {}, codePlan?: OnlineRechargePlan) {
  const config = { version: 17, settings: { ...settings, ...overrides } };
  const tx = {
    onlineRechargeConfig: { findUnique: vi.fn(async () => config) },
    onlineRechargeCode: {
      findUnique: vi.fn(async () =>
        codePlan ? { id: 'fixture-code', plan: codePlan, status: 'available' } : null
      ),
      update: vi.fn(async () => ({ count: 1 }))
    },
    idBusinessV2RechargeProxy: { count: vi.fn(async () => 1) },
    onlineRechargeTask: {
      findUnique: vi.fn(),
      findFirst: vi.fn(async () => null as Record<string, unknown> | null),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }) => ({ id: taskId, status: 'queued', ...data }))
    }
  };
  const repository = { transaction: vi.fn((_key, work) => work(tx)), log: vi.fn() };
  const tasks = new OnlineRechargeTasksRepository(
    repository as never,
    {} as never,
    encryption as never,
    {} as never,
    {} as never
  );
  return { tx, config, tasks };
}

describe('套餐地区规则与任务快照', () => {
  it.each(expected)(
    '%s 以服务端规则覆盖伪造地区，冻结配置版本',
    async (plan, country, currency) => {
      const f = fixture();
      await f.tasks.start(
        {
          session,
          plan,
          region: 'US',
          proxyCountryCode: 'US',
          planRegion: { paymentRegion: 'US' }
        },
        operator,
        'debug'
      );
      expect(f.tx.idBusinessV2RechargeProxy.count).toHaveBeenCalledWith({
        where: { active: true, countryCode: country }
      });
      expect(f.tx.onlineRechargeTask.create.mock.calls[0]?.[0].data.payload).toMatchObject({
        region: country,
        proxyCountryCode: country,
        planRegion: {
          policy: 'plan',
          configVersion: 17,
          targetPlan: plan,
          paymentRegion: country,
          proxyCountryCode: country,
          expectedCurrency: currency
        }
      });
    }
  );

  it('兑换码套餐优先于客户端套餐，银行卡池继续共用', async () => {
    const f = fixture({}, 'pro_5x');
    await f.tasks.start({ session, code: 'synthetic-code', plan: 'plus' }, operator);
    const data = f.tx.onlineRechargeTask.create.mock.calls[0]?.[0].data;
    expect(data.plan).toBe('pro_5x');
    expect(data.payload.planRegion.paymentRegion).toBe('CL');
    expect(data.payload.cardCountry).toBeUndefined();
    expect(f.tx.onlineRechargeCode.update).toHaveBeenCalledOnce();
  });

  it('开关关闭时沿用全局规则，调试手选地区仍有效；新开关默认关闭', () => {
    expect(ONLINE_RECHARGE_DEFAULTS.planRegionRoutingEnabled).toBe(false);
    expect(
      resolvePlanRegion({ ...settings, planRegionRoutingEnabled: false }, 'pro_5x', 1)
    ).toMatchObject({
      policy: 'global',
      proxyCountryCode: 'PH',
      paymentRegion: 'PH',
      expectedCurrency: 'PHP'
    });
    expect(
      resolvePlanRegion({ ...settings, planRegionRoutingEnabled: false }, 'pro_5x', 1, 'CL')
    ).toMatchObject({ policy: 'global', paymentRegion: 'CL', expectedCurrency: 'CLP' });
  });

  it('无智利代理不创建任务，不回退菲律宾', async () => {
    const f = fixture();
    f.tx.idBusinessV2RechargeProxy.count.mockResolvedValue(0);
    await expect(f.tasks.start({ session, plan: 'pro_5x' }, operator)).rejects.toThrow(
      '暂无启用代理'
    );
    expect(f.tx.onlineRechargeTask.create).not.toHaveBeenCalled();
    expect(f.tx.onlineRechargeCode.update).not.toHaveBeenCalled();
    expect(f.tx.idBusinessV2RechargeProxy.count.mock.calls).toHaveLength(1);
  });

  it('智利第三方通道组合停止，不自动改通道或国家', async () => {
    const f = fixture({ gptApiEnabled: true });
    await expect(f.tasks.start({ session, plan: 'pro_5x' }, operator)).rejects.toThrow(
      '尚未核实支持智利'
    );
    expect(f.tx.onlineRechargeTask.create).not.toHaveBeenCalled();
  });

  it('原单核对继承原任务快照；缺少地区资料时停止，不套用新配置', async () => {
    const f = fixture({ planPaymentRegionPro5x: 'PH', planProxyCountryPro5x: 'PH' });
    const route = resolvePlanRegion(settings, 'pro_5x', 3);
    const original = {
      id: taskId,
      status: 'awaiting_review',
      leaseVersion: 1,
      plan: 'pro_5x',
      sessionIdentityHash: 'fixture',
      payload: { region: 'CL', proxyCountryCode: 'CL', planRegion: route }
    };
    f.tx.onlineRechargeTask.findUnique.mockResolvedValue(original);
    const input = { session, plan: 'pro_5x', recheckTaskId: taskId, sourceVersion: 1 };
    await f.tasks.start(input, operator, 'subscription');
    expect(f.tx.onlineRechargeTask.create.mock.calls[0]?.[0].data.payload).toMatchObject({
      region: 'CL',
      proxyCountryCode: 'CL',
      planRegion: route
    });
    f.tx.onlineRechargeTask.create.mockClear();
    f.tx.onlineRechargeTask.findUnique.mockResolvedValue({
      ...original,
      payload: { proxyCountryCode: 'CL' }
    });
    await expect(f.tasks.start(input, operator, 'subscription')).rejects.toThrow(
      '缺少固定支付地区'
    );
    expect(f.tx.onlineRechargeTask.create).not.toHaveBeenCalled();
  });

  it('手工核对复用已经排队的同原单任务，不重复创建', async () => {
    const f = fixture();
    f.tx.onlineRechargeTask.findUnique.mockResolvedValue({
      id: taskId,
      status: 'awaiting_review',
      leaseVersion: 2,
      plan: 'plus',
      sessionIdentityHash: 'fixture',
      payload: { region: 'PH', proxyCountryCode: 'PH' }
    });
    const queued = {
      id: 'queued-read-only',
      message: '',
      status: 'queued',
      operation: 'subscription',
      payload: { recheckTaskId: taskId, sourceVersion: 2 }
    };
    f.tx.onlineRechargeTask.findFirst.mockResolvedValue(queued);
    expect(
      await f.tasks.start(
        { session, plan: 'plus', recheckTaskId: taskId, sourceVersion: 2 },
        operator,
        'subscription'
      )
    ).toMatchObject({ id: queued.id });
    expect(f.tx.onlineRechargeTask.create).not.toHaveBeenCalled();
  });

  it('配置校验不接受未知地区、多个国家或伪造快照', () => {
    for (const overrides of [{ planPaymentRegionPro5x: 'ZZ' }, { planProxyCountryPro5x: 'CL,PH' }])
      expect(() => validatePlanRegions({ ...settings, ...overrides })).toThrow();
    const snapshot = resolvePlanRegion(settings, 'pro_5x', 17);
    const payload = { planRegion: snapshot, region: 'CL', proxyCountryCode: 'CL' };
    expect(taskPlanRegion(payload, 'pro_5x')).toEqual(snapshot);
    for (const changes of [
      { expectedCurrency: 'USD' },
      { targetPlan: 'plus' },
      { configVersion: -1 }
    ])
      expect(() =>
        taskPlanRegion({ ...payload, planRegion: { ...snapshot, ...changes } }, 'pro_5x')
      ).toThrow('快照不一致');
    expect(() => taskPlanRegion({ ...payload, region: 'PH' }, 'pro_5x')).toThrow();
    expect(() => runtimePlanRegion({}, 'plus', 'recharge', settings)).toThrow('旧任务');
    expect(runtimePlanRegion({}, 'plus', 'subscription', settings)).toBeNull();
  });

  it('菲律宾与智利并发任务各用自身快照，运行时全局配置变化不串用', async () => {
    const key = 'synthetic-fixture-worker-key-32-chars';
    const rows = Object.fromEntries(
      ['plus', 'pro_5x'].map((plan) => {
        const route = resolvePlanRegion(settings, plan as OnlineRechargePlan, 17);
        return [
          plan,
          {
            id: plan,
            operation: 'debug',
            plan,
            payload: {
              planRegion: route,
              region: route.paymentRegion,
              proxyCountryCode: route.proxyCountryCode
            }
          }
        ];
      })
    );
    const runtime = {
      ...settings,
      paymentRegion: 'US',
      proxyCountryCode: 'US',
      region: 'US',
      gptApi: { country: 'US', currency: 'USD' }
    };
    const rpc = new OnlineRechargeWorkerRpcRepository(
      {} as never,
      { get: () => key } as never,
      { log: vi.fn() } as never,
      { withLease: vi.fn((input, work) => work({}, rows[input.taskId])) } as never,
      { runtime: async () => runtime, internal: async () => ({ settings: runtime }) } as never,
      encryption as never,
      {} as never,
      {} as never
    );
    const configs = await Promise.all(
      ['plus', 'pro_5x'].map((taskId) => rpc.rpc(key, { method: 'getRuntimeConfig', taskId }))
    );
    expect(configs[0]).toMatchObject({
      region: 'PH',
      proxyCountryCode: 'PH',
      gptApi: { currency: 'PHP' },
      planRegion: { configVersion: 17 }
    });
    expect(configs[1]).toMatchObject({
      region: 'CL',
      proxyCountryCode: 'CL',
      gptApi: { currency: 'CLP' },
      planRegion: { configVersion: 17 }
    });
    expect(await rpc.rpc(key, { method: 'getPaymentRegion', taskId: 'pro_5x' })).toBe('CL');
    expect(runtime.region).toBe('US');
  });
});
