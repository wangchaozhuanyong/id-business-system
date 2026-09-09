import { effectScope, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2RechargeDetails, V2RechargeJob, V2RechargeStart } from './contracts';
import { useAutoRecharge } from './useAutoRecharge';

const mock = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  start: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn()
}));
vi.mock('@/v2/composables/useV2Query', () => ({ useV2ModuleQuery: () => mock.query }));
vi.mock('./api', () => ({
  rechargeApi: { start: mock.start, confirm: mock.confirm, cancel: mock.cancel }
}));
vi.mock('@/api/client', () => ({ getApiErrorMessage: (cause: Error) => cause.message }));
const data = ref<{ configured: boolean; items: V2RechargeJob[] }>({ configured: true, items: [] });
const phase = ref('ready');
let scope = effectScope();
let flow: ReturnType<typeof useAutoRecharge>;
const details: V2RechargeDetails = {
  number: '4242424242424242',
  name: 'Test User',
  expiry: '12/30',
  cvc: '123',
  email: 'test@example.com',
  country: 'MY',
  line1: 'Test street',
  line2: '',
  city: 'Test city',
  state: '',
  postal_code: '50000'
};
const money = { amount: '20.00', currency: 'USD', amount_minor: 2000 };
const quote = {
  plan: 'plus' as const,
  today: money,
  tax: money,
  renewal: money,
  renewal_interval: 'monthly'
};
async function settle() {
  await nextTick();
  await vi.advanceTimersByTimeAsync(600);
  await nextTick();
}
function session() {
  flow.jsonInput.value = '{"account":"test-fixture"}';
  flow.acceptSession();
}
function finishQuote(reason?: string) {
  data.value.items[0] = {
    ...data.value.items[0],
    state: 'finished',
    result: { account_matched: true, quote, ...(reason ? { reason } : {}) }
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  scope = effectScope();
  data.value = { configured: true, items: [] };
  phase.value = 'ready';
  mock.query = { data, phase, error: ref(null), refresh: vi.fn().mockResolvedValue(undefined) };
  mock.start.mockImplementation(async (input: V2RechargeStart) => {
    data.value.items.unshift({
      id: input.id,
      plan: input.plan,
      action: input.action,
      state: 'running',
      result: {},
      createdAt: '',
      updatedAt: ''
    });
    return { id: input.id };
  });
  mock.confirm.mockResolvedValue(undefined);
  flow = scope.run(useAutoRecharge)!;
});
afterEach(() => {
  scope.stop();
  vi.useRealTimers();
});
describe('automatic recharge orchestration', () => {
  it('waits for committed JSON and an explicit plan, then only sends one quote', async () => {
    flow.jsonInput.value = '{';
    flow.acceptSession();
    flow.plan.value = 'plus';
    await settle();
    expect(mock.start).not.toHaveBeenCalled();
    expect(flow.jsonError.value).toBeTruthy();
    flow.plan.value = undefined;
    session();
    await settle();
    expect(mock.start).not.toHaveBeenCalled();
    flow.plan.value = 'plus';
    await settle();
    await settle();
    expect(mock.start).toHaveBeenCalledTimes(1);
    expect(mock.start.mock.calls[0][0].action).toBe('quote');
    expect(mock.start.mock.calls[0][0].details).toBeUndefined();
  });
  it('allows billing during quote, waits for blur and valid quote, then prepares once without payment', async () => {
    session();
    flow.plan.value = 'plus';
    await settle();
    expect(flow.billingLocked.value).toBe(false);
    flow.editingDetails.value = true;
    flow.details.value = { ...details };
    finishQuote();
    await settle();
    expect(mock.start).toHaveBeenCalledTimes(1);
    flow.editingDetails.value = false;
    await settle();
    await settle();
    expect(mock.start).toHaveBeenCalledTimes(2);
    expect(mock.start.mock.calls[1][0].action).toBe('prepare');
    expect(flow.details.value.number).toBe('');
    expect(flow.details.value.cvc).toBe('');
    expect(mock.confirm).not.toHaveBeenCalled();
  });
  it('does not prepare with incomplete details or failed account/quote verification', async () => {
    session();
    flow.plan.value = 'plus';
    await settle();
    finishQuote();
    await settle();
    expect(mock.start).toHaveBeenCalledTimes(1);
    flow.details.value = { ...details };
    finishQuote('official_account_mismatch');
    await settle();
    expect(mock.start).toHaveBeenCalledTimes(1);
  });
  it('does not automatically retry an ambiguous dispatch', async () => {
    mock.start.mockRejectedValue(new Error('transport unknown'));
    session();
    flow.plan.value = 'plus';
    await settle();
    await settle();
    expect(mock.start).toHaveBeenCalledTimes(1);
    expect(flow.accountLocked.value).toBe(true);
    expect(flow.canRetry.value).toBe(false);
    expect(flow.error.value).toBe('transport unknown');
  });
  it('requires a current nonce and consumes confirmation once even if the response is uncertain', async () => {
    data.value.items = [
      {
        id: 'restored',
        plan: 'plus',
        action: 'prepare',
        state: 'awaiting_confirmation',
        result: { quote },
        createdAt: '',
        updatedAt: ''
      }
    ];
    await flow.confirmPayment();
    expect(mock.confirm).not.toHaveBeenCalled();
    data.value.items[0].result.nonce = 'fixture-nonce';
    mock.confirm.mockRejectedValue(new Error('unknown'));
    await flow.confirmPayment();
    await flow.confirmPayment();
    expect(mock.confirm).toHaveBeenCalledTimes(1);
    expect(flow.canConfirm.value).toBe(false);
  });
  it('never restores a finished historical task as the current payment', async () => {
    data.value.items = [
      {
        id: 'history',
        plan: 'plus',
        action: 'prepare',
        state: 'finished',
        result: { quote, nonce: 'fixture-nonce' },
        createdAt: '',
        updatedAt: ''
      }
    ];
    expect(flow.selected.value).toBeUndefined();
    await flow.confirmPayment();
    expect(mock.confirm).not.toHaveBeenCalled();
  });
  it('blocks automation until the query is ready and the worker is configured', async () => {
    phase.value = 'refresh-error';
    session();
    flow.plan.value = 'plus';
    await settle();
    expect(mock.start).not.toHaveBeenCalled();
    phase.value = 'ready';
    data.value.configured = false;
    await settle();
    expect(mock.start).not.toHaveBeenCalled();
    data.value.configured = true;
    await settle();
    expect(mock.start).toHaveBeenCalledTimes(1);
  });
  it('does not use an older record when the new job receipt has not arrived', async () => {
    data.value.items = [
      {
        id: 'old',
        plan: 'plus',
        action: 'quote',
        state: 'finished',
        result: { quote, account_matched: true },
        createdAt: '',
        updatedAt: ''
      }
    ];
    mock.start.mockResolvedValue({ id: 'accepted-but-not-listed' });
    session();
    flow.plan.value = 'plus';
    flow.details.value = { ...details };
    await settle();
    await settle();
    expect(flow.selected.value).toBeUndefined();
    expect(mock.start).toHaveBeenCalledTimes(1);
  });
  it('rejects a quote for a different plan before preparing payment', async () => {
    session();
    flow.plan.value = 'plus';
    await settle();
    finishQuote();
    data.value.items[0].result.quote = { ...quote, plan: 'pro-5x' };
    flow.details.value = { ...details };
    await settle();
    expect(mock.start).toHaveBeenCalledTimes(1);
  });
  it('only rechecks the original payment after an uncertain confirmation', async () => {
    session();
    flow.plan.value = 'plus';
    await settle();
    finishQuote();
    flow.details.value = { ...details };
    await settle();
    data.value.items[0].state = 'awaiting_confirmation';
    data.value.items[0].result = { quote, nonce: 'fixture-nonce' };
    mock.confirm.mockRejectedValue(new Error('unknown'));
    await flow.confirmPayment();
    data.value.items[0].state = 'unknown';
    data.value.items[0].result.payment_attempted = true;
    await settle();
    expect(mock.start).toHaveBeenCalledTimes(2);
    expect(flow.canRecheck.value).toBe(true);
    await flow.recheckPayment();
    expect(mock.start.mock.calls[2][0].action).toBe('recheck');
    expect(mock.start.mock.calls[2][0].plan).toBe('plus');
    expect(mock.confirm).toHaveBeenCalledTimes(1);
  });
  it('cancels queued work and clears sensitive fields when leaving', async () => {
    session();
    flow.plan.value = 'plus';
    flow.details.value = { ...details };
    await nextTick();
    scope.stop();
    await settle();
    expect(mock.start).not.toHaveBeenCalled();
    expect(flow.sessionJson.value).toBe('');
    expect(Object.values(flow.details.value).every((value) => value === '')).toBe(true);
  });
});
