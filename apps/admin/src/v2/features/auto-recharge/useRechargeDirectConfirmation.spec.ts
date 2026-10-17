import { effectScope, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2RechargeJob } from './contracts';
import { useRechargeLocalConfirmation } from './useRechargeLocalConfirmation';
const mock = vi.hoisted(() => ({ access: vi.fn(), helperConfirm: vi.fn(), confirm: vi.fn() }));
vi.mock('./api', () => ({
  rechargeApi: { bitBrowserAccess: mock.access },
  rechargeConnectorApi: { confirm: mock.helperConfirm }
}));
vi.mock('./direct-payment-task', async () => ({
  directPaymentControls: (await import('vue')).shallowReactive(new Map())
}));
import { directPaymentControls } from './direct-payment-task';
let scope = effectScope();
let job = ref<V2RechargeJob>();
beforeEach(() => {
  vi.resetAllMocks();
  directPaymentControls.clear();
  scope = effectScope();
  job = ref({
    id: 'synthetic',
    action: 'bitbrowser',
    state: 'awaiting_confirmation',
    plan: 'plus',
    createdAt: '',
    updatedAt: '',
    result: {
      transport: 'web_direct',
      quote_digest: 'synthetic-digest',
      account_matched: true,
      quote_authority: 'official_checkout_response',
      quote: {
        plan: 'plus',
        today: { amount_minor: 2000, amount: '20', currency: 'USD' },
        tax: null,
        renewal: null,
        renewal_interval: 'monthly'
      },
      payment_attempted: false,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0
    }
  });
  directPaymentControls.set('synthetic', {
    id: 'synthetic',
    digest: 'synthetic-digest',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    pending: true,
    confirming: false,
    message: '',
    confirm: mock.confirm,
    cancel: vi.fn()
  });
});
afterEach(() => {
  scope.stop();
  directPaymentControls.clear();
});
describe('网页人工确认入口', () => {
  it('仅使用原网页内存控制，不读取本机助手的nonce', async () => {
    const flow = scope.run(() => useRechargeLocalConfirmation(job, vi.fn()))!;
    expect(flow.confirmationEnabled.value).toBe(true);
    await flow.confirm();
    expect(mock.confirm).toHaveBeenCalledOnce();
    expect(mock.access).not.toHaveBeenCalled();
    expect(mock.helperConfirm).not.toHaveBeenCalled();
  });
  it('刷新后无原网页控制，不能恢复单次确认授权', async () => {
    directPaymentControls.clear();
    const flow = scope.run(() => useRechargeLocalConfirmation(job, vi.fn()))!;
    expect(flow.confirmationEnabled.value).toBe(false);
    await flow.confirm();
    expect(mock.confirm).not.toHaveBeenCalled();
    expect(mock.access).not.toHaveBeenCalled();
  });
  it.each(['digest', 'attempted', 'count', 'expired'])('%s不一致均禁止确认', (scenario) => {
    if (scenario === 'digest') job.value!.result.quote_digest = 'different';
    if (scenario === 'attempted') job.value!.result.payment_attempted = true;
    if (scenario === 'count') job.value!.result.confirmation_requests_sent = 1;
    if (scenario === 'expired')
      directPaymentControls.set('synthetic', {
        ...directPaymentControls.get('synthetic')!,
        expiresAt: 'invalid'
      });
    const flow = scope.run(() => useRechargeLocalConfirmation(job, vi.fn()))!;
    expect(flow.confirmationEnabled.value).toBe(false);
  });
});
