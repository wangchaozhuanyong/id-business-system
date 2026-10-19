import { createRenderer, h, nextTick, ref, ssrContextKey, type Component } from 'vue';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import type { V2RechargeJob } from './contracts';
import RechargeManualSettlement from './RechargeManualSettlement.vue';
const api = vi.hoisted(() => ({ settle: vi.fn(), message: vi.fn() }));
vi.mock('./api', () => ({ rechargeApi: { settleManually: api.settle } }));
vi.mock('@/api/client', () => ({ getApiErrorMessage: (error: Error) => error.message }));
vi.mock('@/v2/services/elementPlusMessage', () => ({ ElMessage: { success: api.message } }));
vi.mock('@/components/ui/AppButton.vue', () => ({ default: {} }));
vi.mock('@/v2/components/V2ConfirmDialog.vue', () => ({ default: {} }));
type Node = { children: Node[]; parent: Node | null };
const node = (): Node => ({ children: [], parent: null });
const renderer = createRenderer<Node, Node>({
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
let app: ReturnType<typeof renderer.createApp> | undefined;

function source(): V2RechargeJob {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    action: 'bitbrowser',
    plan: 'plus',
    state: 'finished',
    createdAt: '2026-10-17T10:00:00.000Z',
    updatedAt: '2026-10-17T10:02:00.000Z',
    availability: {
      execution: 'released',
      payment: 'unknown',
      accountPaymentRestricted: true,
      canInspect: true
    },
    result: {
      payment_attempted: true,
      confirmation_requests_sent: 1,
      payment_status: 'requires_action',
      checkout_identifier: 'oaics_synthetic'
    }
  };
}
type Flow = {
  eligible: boolean;
  canFail: boolean;
  dialogOpen: boolean;
  bankConfirmed: boolean;
  subscriptionConfirmed: boolean;
  saving: boolean;
  error: string;
  disabledReason: string;
  form: Record<string, string>;
  open: (outcome: 'success' | 'failure') => void;
  save: () => Promise<void>;
};
function mount(job = ref(source()), busy = ref(false)) {
  const emitted = { complete: vi.fn(), busy: vi.fn() };
  let flow: Flow;
  const component = { ...RechargeManualSettlement, render: () => h('div') } as Component;
  app = renderer.createApp({
    setup() {
      return () =>
        h(component, {
          job: job.value,
          busy: busy.value,
          onCompleted: emitted.complete,
          'onBusy-change': emitted.busy,
          ref: (instance: unknown) => {
            if (instance) flow = (instance as { $: { setupState: Flow } }).$.setupState;
          }
        });
    }
  });
  app.provide(ssrContextKey, {});
  app.mount(node());
  return {
    get flow() {
      return flow!;
    },
    job,
    busy,
    emitted
  };
}
function confirm(flow: Flow) {
  flow.bankConfirmed = true;
  flow.subscriptionConfirmed = true;
  flow.form.reason = '已核对真实结果';
}
beforeEach(() => {
  clearV2SessionDrafts();
  vi.clearAllMocks();
  api.settle.mockResolvedValue({ id: 'result', alreadyResolved: false });
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  clearV2SessionDrafts();
});
describe('人工结单页面实际命令流程', () => {
  it('默认两项不勾选，失败不发送银行或官网请求，只提交原单人工确认', async () => {
    const f = mount(),
      flow = f.flow;
    expect(flow.eligible).toBe(true);
    expect(flow.disabledReason).toContain('原任务已变化');
    flow.open('failure');
    expect(flow.bankConfirmed).toBe(false);
    await flow.save();
    expect(api.settle).not.toHaveBeenCalled();
    confirm(flow);
    expect(flow.disabledReason).toBe('');
    await flow.save();
    expect(api.settle).toHaveBeenCalledWith(
      f.job.value.id,
      expect.objectContaining({
        outcome: 'failure',
        identifier: 'oaics_synthetic',
        expectedUpdatedAt: f.job.value.updatedAt,
        noDebitConfirmed: true,
        notActivatedConfirmed: true,
        confirmed: true
      })
    );
    expect(f.emitted.complete).toHaveBeenCalledOnce();
    expect(flow.dialogOpen).toBe(false);
  });
  it('关闭重开保留说明，但不保留银行和订阅声明', () => {
    const f = mount(),
      flow = f.flow;
    flow.open('failure');
    confirm(flow);
    const operation = flow.form.operationId;
    flow.dialogOpen = false;
    flow.open('failure');
    expect(flow.form.reason).toBe('已核对真实结果');
    expect(flow.form.operationId).toBe(operation);
    expect(flow.bankConfirmed).toBe(false);
    expect(flow.subscriptionConfirmed).toBe(false);
  });
  it('成功必须填写真实金额、币种、凭据及日期，并使用同一个原任务', async () => {
    const f = mount(),
      flow = f.flow;
    flow.open('success');
    confirm(flow);
    await flow.save();
    expect(api.settle).not.toHaveBeenCalled();
    Object.assign(flow.form, {
      amount: '982.14',
      currency: 'php',
      evidenceRef: 'BANK-SYNTHETIC',
      openedAt: '2026-10-17T18:00',
      dueAt: '2026-11-17T18:00'
    });
    api.settle.mockResolvedValue({ id: f.job.value.id, orderId: 'order' });
    await flow.save();
    expect(api.settle).toHaveBeenCalledWith(
      f.job.value.id,
      expect.objectContaining({
        outcome: 'success',
        amount: '982.14',
        currency: 'PHP',
        subscriptionConfirmed: true,
        evidenceRef: 'BANK-SYNTHETIC'
      })
    );
    expect(api.message).toHaveBeenCalledWith(expect.stringContaining('补全财务资料'));
  });
  it('网络失败保留输入和操作编号，重复点击只提交一次', async () => {
    const f = mount(),
      flow = f.flow;
    flow.open('failure');
    confirm(flow);
    const operation = flow.form.operationId;
    let reject!: (cause: Error) => void;
    api.settle.mockImplementation(
      () =>
        new Promise((_resolve, no) => {
          reject = no;
        })
    );
    const pending = flow.save();
    await flow.save();
    expect(api.settle).toHaveBeenCalledOnce();
    reject(new Error('网络中断'));
    await pending;
    expect(flow.dialogOpen).toBe(true);
    expect(flow.form.operationId).toBe(operation);
    expect(flow.form.reason).toBe('已核对真实结果');
    expect(flow.error).toBe('网络中断');
  });
  it('原任务刷新变化关闭旧确认，不能把旧声明应用到另一单', async () => {
    const f = mount(),
      flow = f.flow;
    flow.open('failure');
    confirm(flow);
    f.job.value = { ...source(), id: '22222222-2222-4222-8222-222222222222' };
    await nextTick();
    expect(flow.dialogOpen).toBe(false);
    expect(flow.bankConfirmed).toBe(false);
    await flow.save();
    expect(api.settle).not.toHaveBeenCalled();
  });
  it.each([
    { action: 'server' },
    { state: 'running' },
    { result: { recheck_only: true } },
    { result: { manual_settlement: { outcome: 'failure' } } },
    { result: { confirmation_requests_sent: 0 } }
  ])('非原始待核实付款不提供人工结单：%j', async (patch) => {
    const job = source();
    Object.assign(job, {
      ...patch,
      ...('result' in patch ? { result: { ...job.result, ...patch.result } } : {})
    });
    const f = mount(ref(job));
    expect(f.flow.eligible).toBe(false);
    f.flow.open('failure');
    await f.flow.save();
    expect(api.settle).not.toHaveBeenCalled();
  });
  it('已有官网付款证据不提供失败操作', () => {
    const job = source();
    job.result.payment_status = 'paid';
    job.result.payment_evidence = {
      kind: 'checkout_session',
      identifier: 'oaics_synthetic',
      amount_minor: 98214,
      currency: 'PHP'
    };
    const f = mount(ref(job));
    expect(f.flow.canFail).toBe(false);
    f.flow.open('failure');
    expect(f.flow.dialogOpen).toBe(false);
  });
});
