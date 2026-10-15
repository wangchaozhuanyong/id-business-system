import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ref, ssrContextKey, type Component, type VNode } from 'vue';
import { onlineCell, onlineChangeEntries, onlineLabel, planOptions } from './labels';
import { configGroups } from './configFields';
import { topActions } from './sections';
import { onlineTableSchemas } from './tableSchemas';
import { onlineRechargeLoginLogsFeature } from './login-logs-manifest';

const fixture = vi.hoisted(() => ({ overview: {} as Record<string, unknown> }));
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ user: { id: 'synthetic-admin', roles: ['admin'], permissions: [] } })
}));
vi.mock('@/api/client', () => ({
  http: { get: vi.fn() },
  getApiErrorMessage: (cause: Error) => cause.message
}));
vi.mock('./api', () => ({ onlineApi: {}, copyOnlineText: vi.fn() }));
vi.mock('@/v2/components/V2ConfirmDialog.vue', () => ({ default: { render: () => null } }));
vi.mock('./useOnlineTask', async () => {
  const { ref } = await import('vue');
  return { useOnlineTask: () => ({ connected: ref(false), error: ref(''), refresh: vi.fn() }) };
});
vi.mock('@/v2/composables/useV2Query', async () => {
  const { ref } = await import('vue');
  return {
    useV2ModuleQuery: () => ({
      data: ref(fixture.overview),
      phase: ref('ready'),
      error: ref(),
      refresh: vi.fn()
    })
  };
});
import OnlineResultDialog from './OnlineResultDialog.vue';
import OnlineTaskProgress from './OnlineTaskProgress.vue';
import V2OnlineOverviewView from './V2OnlineOverviewView.vue';

type TestNode = { parent: TestNode | null; children: TestNode[] };
const node = (): TestNode => ({ parent: null, children: [] });
const renderer = createRenderer<TestNode, TestNode>({
  patchProp: () => undefined,
  insert(child, parent) {
    child.parent = parent;
    parent.children.push(child);
  },
  remove(child) {
    if (child.parent)
      child.parent.children = child.parent.children.filter((item) => item !== child);
  },
  createElement: node,
  createText: node,
  createComment: node,
  setText: () => undefined,
  setElementText: () => undefined,
  parentNode: (child) => child.parent,
  nextSibling: () => null
});
const unmounts: (() => void)[] = [];
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()));
function mount<T>(component: Component, props: () => Record<string, unknown> = () => ({})) {
  let rendered!: VNode;
  const subject = { ...component, render: () => null } as Component;
  const app = renderer.createApp({ setup: () => () => (rendered = h(subject, props())) });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  unmounts.push(() => app.unmount());
  return (rendered.component as unknown as { setupState: T }).setupState;
}
type ResultState = {
  liveTask?: { id: string; status: string };
  entries: { label: string; value: string }[];
};
function resultState(result: unknown) {
  return mount<ResultState>(OnlineResultDialog, () => ({ result, modelValue: true }));
}

describe('线上代充审计发现的结果展示', () => {
  it('未关联任务的兑换码不会被误当作充值任务', () => {
    const state = resultState({ id: 'code-id', status: 'available', plan: 'plus', task: null });
    expect(state.liveTask).toBeUndefined();
    expect(state.entries).toContainEqual({ label: '记录编号', value: 'code-id' });
  });
  it('兑换码跟踪真正关联的任务，同时保留兑换码记录编号', () => {
    const state = resultState({
      id: 'code-id',
      status: 'reserved',
      task: { id: 'actual-task', status: 'running', operation: 'recharge', progress: 20 }
    });
    expect(state.liveTask?.id).toBe('actual-task');
    expect(state.entries).toContainEqual({ label: '记录编号', value: 'code-id' });
  });
  it('账单详情含 id 与 status 也不能触发任务跟踪', () => {
    expect(
      resultState({ id: 'bill-id', status: 'success', amount: '24.00' }).liveTask
    ).toBeUndefined();
  });
  it('真实任务仍可更新，关闭时清除任务引用', async () => {
    const open = ref(true);
    const state = mount<ResultState>(OnlineResultDialog, () => ({
      modelValue: open.value,
      result: { id: 'actual-task', status: 'running', operation: 'proxy_test' }
    }));
    expect(state.liveTask?.id).toBe('actual-task');
    open.value = false;
    await nextTick();
    expect(state.liveTask).toBeUndefined();
  });
  it('消费汇总保留每张卡、币种、精确金额和笔数，不展示凭据', () => {
    const state = resultState([
      { cardLast4: '0001', currency: 'USD', amount: '190.25', count: 2, cvc: 'synthetic-secret' },
      { cardLast4: '0002', currency: 'PHP', amount: '24.00', count: 1 }
    ]);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].value).toContain('卡尾号：0001\n币种：USD\n实际金额：190.25\n数量：2');
    expect(state.entries[0].value).toContain('卡尾号：0002\n币种：PHP\n实际金额：24.00');
    expect(state.entries[0].value).not.toContain('synthetic-secret');
  });
  it('空汇总显示明确空状态', () => {
    expect(resultState([]).entries).toEqual([
      { label: '卡片消费汇总', value: '暂无已确认成功的消费记录' }
    ]);
  });
  it('概览将非充值成功与已确认付款分开，缺失新增数据不推定为零', () => {
    fixture.overview = {
      tasks: [{ status: 'succeeded', _count: 6 }],
      rechargeTasks: [],
      confirmedRechargeCount: 0
    };
    const state = mount<{ metrics: { label: string; value: unknown }[] }>(V2OnlineOverviewView);
    expect(state.metrics.find((item) => item.label === '任务成功')?.value).toBe(6);
    expect(state.metrics.find((item) => item.label === '已确认充值')?.value).toBe(0);
    fixture.overview = { tasks: [{ status: 'succeeded', _count: 6 }] };
    const missing = mount<{ metrics: { label: string; value: unknown }[] }>(V2OnlineOverviewView);
    expect(missing.metrics.find((item) => item.label === '已确认充值')?.value).toBe('—');
  });
  it('字段使用已约定投影且代理提取模式显示中文', () => {
    expect(onlineTableSchemas.jobs.columns.map((item) => item.key)).toContain('operation');
    expect(onlineTableSchemas.jobs.columns.map((item) => item.key)).toContain('confirmedPaid');
    expect(
      onlineTableSchemas['browser-pool'].columns.find((item) => item.key === 'updatedAt')?.label
    ).toBe('观测时间');
    expect(onlineCell({ id: 'proxy', protocol: 'extraction' }, 'protocol')).toBe('动态提取链接');
    expect(onlineRechargeLoginLogsFeature.requiredRoles).toEqual(['admin']);
  });
  it('目标套餐贯通旧兑换码与 Pro 500，不猜测新的官网创建标识', () => {
    expect(planOptions).toEqual([
      { value: 'plus', label: 'Plus 套餐' },
      { value: 'pro_5x', label: 'Pro 100 套餐' },
      { value: 'pro_20x', label: 'Pro 200 套餐' },
      { value: 'pro_500', label: 'Pro 500 套餐' }
    ]);
    for (const action of topActions.cdks ?? []) {
      const plan = action.fields?.find((field) => field.key === 'plan');
      if (plan) expect(plan.options).toBe(planOptions);
    }
    const config = configGroups.find((group) => group.key === 'plans');
    expect(config?.fields.find((field) => field.key === 'planNamePro500')?.initial).toBe('');
    expect(onlineLabel('pro')).toBe('待核对');
  });
  it('升级详情保持官网精确差额，列表从同一套餐变更投影读取', () => {
    const subscriptionChange = {
      kind: 'upgrade',
      sourcePlan: 'plus',
      targetPlan: 'pro_500',
      amount: '29008.93',
      currency: 'PHP',
      cardLast4: '0001'
    };
    const result = { subscriptionChange };
    expect(onlineChangeEntries(result)).toContainEqual({
      label: '官网本次应付',
      value: '29008.93'
    });
    expect(onlineCell({ id: 'task', subscriptionChange }, 'changeKind', 'status')).toBe('套餐升级');
    expect(onlineCell({ id: 'task', subscriptionChange }, 'sourcePlan', 'status')).toBe(
      'Plus 套餐'
    );
    expect(onlineCell({ id: 'task', subscriptionChange }, 'payableAmount', 'numeric')).toBe(
      '29008.93'
    );
    const state = resultState({ subscriptionChange, result });
    const summary = state.entries.find((entry) => entry.label === '套餐变更与官网报价');
    expect(summary?.value).toContain('目标套餐：Pro 500');
    expect(summary?.value).toContain('官网本次应付：29008.93');
    expect(summary?.value).toContain('付款币种：PHP');
    expect(state.entries.find((entry) => entry.label === '执行结果')?.value).not.toContain(
      '目标套餐'
    );
  });
  it('缺失报价不显示零，官网明确零应付保持原数值', () => {
    const missing = {
      subscriptionChange: {
        kind: 'initial',
        sourcePlan: 'free',
        targetPlan: 'pro_500',
        amount: null,
        currency: null
      }
    };
    expect(onlineChangeEntries(missing)).toContainEqual({
      label: '官网本次应付',
      value: '待获取官网报价'
    });
    expect(
      onlineChangeEntries({
        subscriptionChange: { ...missing.subscriptionChange, amount: '0.00', currency: 'USD' }
      })
    ).toContainEqual({ label: '官网本次应付', value: '0.00' });
    expect(onlineCell({ id: 'legacy-task' }, 'sourcePlan', 'status')).toBe('—');
    expect(onlineCell({ id: 'legacy-task' }, 'payableAmount', 'numeric')).toBe('—');
    expect(onlineChangeEntries()).toEqual([]);
  });
  it('实时任务优先读取服务端套餐变更投影，明确缺失不展示旧结果', () => {
    const subscriptionChange = {
      kind: 'upgrade',
      sourcePlan: 'pro_5x',
      targetPlan: 'pro_500',
      amount: '0.00',
      currency: 'USD'
    };
    const state = mount<{ changeEntries: { label: string; value: string }[] }>(
      OnlineTaskProgress,
      () => ({
        task: {
          id: 'original-task',
          status: 'awaiting_review',
          plan: 'pro_500',
          subscriptionChange
        }
      })
    );
    expect(state.changeEntries).toContainEqual({ label: '变更前套餐', value: 'Pro 100 套餐' });
    expect(state.changeEntries).toContainEqual({ label: '官网本次应付', value: '0.00' });
    expect(
      onlineChangeEntries({ subscriptionChange: null, result: { subscriptionChange } })
    ).toEqual([]);
    expect(onlineChangeEntries({ result: { subscriptionChange } })).toEqual([]);
    expect(resultState({ stage: 'verification' }).entries).toContainEqual({
      label: '执行阶段',
      value: '验证结果'
    });
  });
});
