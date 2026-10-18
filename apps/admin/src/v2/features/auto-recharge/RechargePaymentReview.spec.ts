import { createRenderer, h, nextTick, ref, ssrContextKey, type Ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import type { V2RechargeJob, V2RechargeReviewPage } from './contracts';
import RechargePaymentReview from './RechargePaymentReview.vue';

const api = vi.hoisted(() => ({ resolve: vi.fn(), confirm: vi.fn() }));
vi.mock('./api', () => ({ rechargeApi: { resolveDeclined: api.resolve, review: vi.fn() } }));
vi.mock('@/api/client', () => ({ getApiErrorMessage: (error: Error) => error.message }));
vi.mock('element-plus/es/components/message-box/index.mjs', () => ({
  ElMessageBox: { confirm: api.confirm }
}));
vi.mock('@/v2/composables/useV2Query', () => ({
  createV2QueryKey: (value: unknown) => JSON.stringify(value),
  useV2ModuleQuery: () => query
}));
vi.mock('@/components/ui/AppButton.vue', () => ({ default: {} }));
vi.mock('@/v2/components/V2SearchInput.vue', () => ({ default: {} }));
vi.mock('@/v2/components/V2AsyncRegion.vue', () => ({ default: {} }));
vi.mock('@/v2/components/V2ConfirmDialog.vue', () => ({ default: {} }));
vi.mock('./RechargeResult.vue', () => ({ default: {} }));

type Query = {
  data: Ref<V2RechargeReviewPage>;
  phase: Ref<string>;
  hasLoadedOnce: Ref<boolean>;
  error: Ref<Error | undefined>;
  refresh: ReturnType<typeof vi.fn>;
  ensureFresh: ReturnType<typeof vi.fn>;
};
let query: Query;
type ReviewFlow = {
  draft: { selectedId: string; page: number };
  verificationResolution?: NonNullable<V2RechargeJob['result']['payment_verification_resolution']>;
  verificationSnapshot?: {
    sourceId: string;
    proof: NonNullable<V2RechargeJob['result']['payment_verification_resolution']>;
    cardLast4?: string;
  };
  verificationDialogOpen: boolean;
  officialFailureConfirmed: boolean;
  bankNoDebitConfirmed: boolean;
  verificationDisabledReason: string;
  resolving: boolean;
  commandError: string;
  openVerificationResolution: () => void;
  resolveVerificationFailure: () => Promise<void>;
  resolveDeclined: () => Promise<void>;
};
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
const sourceId = 'aaaaaaaa-1111-4222-8333-444444444444';
const verificationId = 'bbbbbbbb-1111-4222-8333-444444444444';
function source(
  basis:
    | 'captured_official_failure'
    | 'operator_observation_required' = 'operator_observation_required'
): V2RechargeJob {
  return {
    id: sourceId,
    plan: 'go',
    action: 'bitbrowser',
    state: 'finished',
    createdAt: '2026-10-17T12:00:00.000Z',
    updatedAt: '2026-10-17T12:05:00.000Z',
    availability: {
      execution: 'released',
      payment: 'unknown',
      accountPaymentRestricted: true,
      canInspect: true
    },
    result: {
      reason: 'unexpected_payment_observed',
      status: 'payment_result_unknown',
      checkout_identifier: 'oaics_original',
      payment_status: 'unknown',
      payment_attempted: true,
      payment_requests_sent: 1,
      confirmation_requests_sent: 0,
      card_last4: '1234',
      payment_verification_resolution: {
        basis,
        checkoutIdentifier: 'oaics_original',
        verificationJobId: verificationId,
        verifiedAt: '2026-10-18T12:00:00.000Z',
        accountMatched: true,
        currentPlan: 'free'
      }
    }
  };
}
function mount(busy = false) {
  // Exercise the actual setup/command flow without browser-only Element Plus rendering.
  app = renderer.createApp(
    { ...RechargePaymentReview, render: () => h('div') },
    { busy, inspectionReady: true }
  );
  app.provide(ssrContextKey, {});
  app.mount(node());
  const flow = (app._instance as unknown as { setupState: ReviewFlow }).setupState;
  flow.draft.selectedId = query.data.value.items[0]!.id;
  return flow;
}
function confirmBoth(flow: ReviewFlow) {
  flow.officialFailureConfirmed = true;
  flow.bankNoDebitConfirmed = true;
}
beforeEach(() => {
  clearV2SessionDrafts();
  vi.clearAllMocks();
  api.resolve.mockResolvedValue({ id: 'resolution', alreadyResolved: false });
  api.confirm.mockResolvedValue('confirm');
  query = {
    data: ref({ items: [source()], total: 1, page: 1, pageSize: 20 }),
    phase: ref('ready'),
    hasLoadedOnce: ref(true),
    error: ref(),
    refresh: vi.fn().mockResolvedValue(undefined),
    ensureFresh: vi.fn().mockResolvedValue(undefined)
  };
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  clearV2SessionDrafts();
});

describe('支付方式验证失败原单人工核实', () => {
  it.each(['captured_official_failure', 'operator_observation_required'] as const)(
    '%s 展示绑定原单和真实的新免费核验，初始两项均未确认且不能提交',
    async (basis) => {
      query.data.value.items = [source(basis)];
      const flow = mount();
      flow.openVerificationResolution();
      expect(flow.verificationSnapshot).toMatchObject({
        sourceId,
        cardLast4: '1234',
        proof: {
          checkoutIdentifier: 'oaics_original',
          verificationJobId: verificationId,
          verifiedAt: '2026-10-18T12:00:00.000Z',
          accountMatched: true,
          currentPlan: 'free'
        }
      });
      expect(flow.officialFailureConfirmed).toBe(false);
      expect(flow.bankNoDebitConfirmed).toBe(false);
      expect(flow.verificationDisabledReason).toContain('本人');
      await flow.resolveVerificationFailure();
      expect(api.resolve).not.toHaveBeenCalled();
    }
  );

  it.each(['official', 'bank'] as const)('仅确认%s一项不会发送命令', async (confirmation) => {
    const flow = mount();
    flow.openVerificationResolution();
    if (confirmation === 'official') flow.officialFailureConfirmed = true;
    else flow.bankNoDebitConfirmed = true;
    await flow.resolveVerificationFailure();
    expect(api.resolve).not.toHaveBeenCalled();
  });

  it.each(['captured_official_failure', 'operator_observation_required'] as const)(
    '%s 仅本人完成两项确认后提交正确绑定，保留原付款事实',
    async (basis) => {
      query.data.value.items = [source(basis)];
      const before = JSON.stringify(query.data.value.items[0]!.result);
      const flow = mount();
      flow.openVerificationResolution();
      confirmBoth(flow);
      await flow.resolveVerificationFailure();
      expect(api.resolve).toHaveBeenCalledExactlyOnceWith(sourceId, {
        confirmNoDebit: true,
        verificationJobId: verificationId,
        ...(basis === 'operator_observation_required'
          ? {
              verificationFailureObservation: {
                checkoutIdentifier: 'oaics_original',
                officialMessage: 'payment_method_verification_failed'
              }
            }
          : {})
      });
      expect(JSON.stringify(query.data.value.items[0]!.result)).toBe(before);
      expect(query.refresh).toHaveBeenCalledOnce();
      expect(flow.verificationDialogOpen).toBe(false);
      expect(flow.officialFailureConfirmed).toBe(false);
      expect(flow.bankNoDebitConfirmed).toBe(false);
    }
  );

  it('关闭取消清除单次授权，重开及重挂载不会恢复勾选', async () => {
    let flow = mount();
    flow.openVerificationResolution();
    confirmBoth(flow);
    flow.verificationDialogOpen = false;
    flow.openVerificationResolution();
    expect(flow.officialFailureConfirmed).toBe(false);
    expect(flow.bankNoDebitConfirmed).toBe(false);
    confirmBoth(flow);
    app!.unmount();
    app = undefined;
    flow = mount();
    expect(flow.verificationDialogOpen).toBe(false);
    flow.openVerificationResolution();
    expect(flow.officialFailureConfirmed).toBe(false);
    expect(flow.bankNoDebitConfirmed).toBe(false);
    await flow.resolveVerificationFailure();
    expect(api.resolve).not.toHaveBeenCalled();
  });

  it.each(['selection', 'verification', 'checkout', 'account', 'payment', 'version'] as const)(
    '%s 绑定变化立即取消原确认，提交前不沿用旧快照',
    async (change) => {
      const other = { ...source(), id: 'cccccccc-1111-4222-8333-444444444444' };
      query.data.value.items.push(other);
      const flow = mount();
      flow.openVerificationResolution();
      confirmBoth(flow);
      const row = query.data.value.items[0]!;
      if (change === 'selection') flow.draft.selectedId = other.id;
      else if (change === 'verification')
        row.result.payment_verification_resolution!.verificationJobId = other.id;
      else if (change === 'checkout') row.result.checkout_identifier = 'oaics_changed';
      else if (change === 'account')
        row.result.payment_verification_resolution!.accountMatched = false as true;
      else if (change === 'payment') row.result.payment_requests_sent = 2;
      else row.updatedAt = '2026-10-18T13:00:00.000Z';
      await flow.resolveVerificationFailure();
      expect(flow.verificationDialogOpen).toBe(false);
      expect(flow.officialFailureConfirmed).toBe(false);
      expect(flow.bankNoDebitConfirmed).toBe(false);
      expect(flow.commandError).toContain('已变化');
      expect(api.resolve).not.toHaveBeenCalled();
    }
  );

  it.each(['absent', 'wrong_checkout', 'paid_plan', 'unmatched', 'resolved'] as const)(
    '服务端能力%s不能创建可提交的核实对话框',
    async (condition) => {
      const row = query.data.value.items[0]!;
      if (condition === 'absent') delete row.result.payment_verification_resolution;
      else if (condition === 'wrong_checkout')
        row.result.payment_verification_resolution!.checkoutIdentifier = 'oaics_other';
      else if (condition === 'paid_plan')
        row.result.payment_verification_resolution!.currentPlan = 'plus' as 'free';
      else if (condition === 'unmatched')
        row.result.payment_verification_resolution!.accountMatched = false as true;
      else row.result.operator_resolution = 'confirmed_verification_failed_no_charge';
      const flow = mount();
      flow.openVerificationResolution();
      confirmBoth(flow);
      await flow.resolveVerificationFailure();
      expect(flow.verificationResolution).toBeUndefined();
      expect(flow.verificationDialogOpen).toBe(false);
      expect(api.resolve).not.toHaveBeenCalled();
    }
  );

  it('执行中或查询刷新时不接受核实命令', async () => {
    let flow = mount(true);
    flow.openVerificationResolution();
    expect(flow.verificationDialogOpen).toBe(false);
    app!.unmount();
    app = undefined;
    flow = mount();
    flow.openVerificationResolution();
    confirmBoth(flow);
    query.phase.value = 'refreshing';
    await flow.resolveVerificationFailure();
    expect(api.resolve).not.toHaveBeenCalled();
  });

  it('连续点击只发送一次命令并在请求完成前保持占用', async () => {
    let complete!: (value: object) => void;
    api.resolve.mockImplementation(() => new Promise((resolve) => (complete = resolve)));
    const flow = mount();
    flow.openVerificationResolution();
    confirmBoth(flow);
    const pending = flow.resolveVerificationFailure();
    expect(flow.resolving).toBe(true);
    await flow.resolveVerificationFailure();
    expect(api.resolve).toHaveBeenCalledOnce();
    complete({ id: 'resolution', alreadyResolved: false });
    await pending;
    expect(flow.resolving).toBe(false);
  });

  it('失败保留当前确认并显示错误，旧请求迟到不覆盖新选原单', async () => {
    const flow = mount();
    flow.openVerificationResolution();
    confirmBoth(flow);
    api.resolve.mockRejectedValueOnce(new Error('银行核验记录已变化'));
    await flow.resolveVerificationFailure();
    expect(flow.commandError).toBe('银行核验记录已变化');
    expect(flow.verificationDialogOpen).toBe(true);
    expect(flow.resolving).toBe(false);
    let reject!: (error: Error) => void;
    api.resolve.mockImplementationOnce(() => new Promise((_resolve, fail) => (reject = fail)));
    const pending = flow.resolveVerificationFailure();
    flow.draft.selectedId = 'other';
    const currentError = flow.commandError;
    reject(new Error('旧原单迟到错误'));
    await pending;
    expect(flow.commandError).toBe(currentError);
    expect(flow.commandError).not.toContain('迟到');
    expect(flow.verificationDialogOpen).toBe(false);
    expect(query.refresh).not.toHaveBeenCalled();
  });

  it('请求结束前卸载组件后不刷新或恢复确认', async () => {
    let complete!: (value: object) => void;
    api.resolve.mockImplementationOnce(() => new Promise((resolve) => (complete = resolve)));
    const flow = mount();
    flow.openVerificationResolution();
    confirmBoth(flow);
    const pending = flow.resolveVerificationFailure();
    app!.unmount();
    app = undefined;
    complete({ id: 'resolution', alreadyResolved: false });
    await pending;
    expect(query.refresh).not.toHaveBeenCalled();
  });

  it('原有明确拒付入口仍按旧签名调用', async () => {
    const row = query.data.value.items[0]!;
    delete row.result.payment_verification_resolution;
    row.result.payment_status = 'declined';
    row.result.resolution_verification_job_id = verificationId;
    row.availability!.payment = 'declined';
    const flow = mount();
    await flow.resolveDeclined();
    expect(api.confirm).toHaveBeenCalledOnce();
    expect(api.resolve).toHaveBeenCalledExactlyOnceWith(sourceId, verificationId);
    await nextTick();
  });
});
