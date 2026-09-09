import { effectScope, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2RechargeDetails, V2RechargeJob, V2RechargeStart } from './contracts';
import { useAutoRecharge } from './useAutoRecharge';

const mock = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  addressQuery: {} as Record<string, unknown>,
  jobOptions: undefined as
    | undefined
    | {
        getRevalidateAt?: (data: { configured: boolean; items: V2RechargeJob[] }) => number | null;
      },
  addressOptions: undefined as undefined | { query: (input: { signal: AbortSignal }) => unknown },
  start: vi.fn(),
  submitDetails: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  listAddresses: vi.fn()
}));
vi.mock('@/v2/composables/useV2Query', () => ({
  useV2ModuleQuery: (options: {
    moduleKey: string;
    getRevalidateAt?: (data: { configured: boolean; items: V2RechargeJob[] }) => number | null;
    query: (input: { signal: AbortSignal }) => unknown;
  }) => {
    if (options.moduleKey === 'auto-recharge-addresses') {
      mock.addressOptions = options;
      return mock.addressQuery;
    }
    mock.jobOptions = options;
    return mock.query;
  }
}));
vi.mock('./api', () => ({
  rechargeApi: {
    start: mock.start,
    submitDetails: mock.submitDetails,
    confirm: mock.confirm,
    cancel: mock.cancel,
    listAddresses: mock.listAddresses
  }
}));
vi.mock('@/api/client', () => ({ getApiErrorMessage: (cause: Error) => cause.message }));

const data = ref<{ configured: boolean; items: V2RechargeJob[] }>({ configured: true, items: [] });
const phase = ref('ready');
const addressPhase = ref('ready');
let scope = effectScope();
let flow: ReturnType<typeof useAutoRecharge>;
const address = {
  id: '22222222-2222-4222-8222-222222222222',
  line1: '1221 SW Fourth Avenue',
  country: 'US' as const,
  city: 'Portland' as const,
  state: 'OR' as const,
  postalCode: '97204' as const,
  status: 'unused' as const,
  usedAt: null,
  createdAt: '',
  updatedAt: ''
};
const addressData = ref({
  items: [address],
  total: 1,
  page: 1,
  pageSize: 2000,
  totals: { unused: 1, used: 0, disabled: 0 }
});
const completeDetails: V2RechargeDetails = {
  number: '5555555555554444',
  name: 'Test User',
  expiry: '12/30',
  cvc: '123',
  email: 'test@example.com',
  country: 'US',
  line1: address.line1,
  line2: '',
  city: 'Portland',
  state: 'OR',
  postal_code: '97204'
};
const zero = { amount: '0.00', currency: 'USD', amount_minor: 0 };
const money = { amount: '20.00', currency: 'USD', amount_minor: 2000 };
const quote = {
  plan: 'plus' as const,
  today: money,
  tax: zero,
  renewal: money,
  renewal_interval: 'monthly'
};

function session() {
  flow.jsonInput.value = '{"account":"test-fixture"}';
  flow.acceptSession();
}
function selectAddress() {
  flow.selectedAddressId.value = address.id;
  flow.details.value = { ...completeDetails };
}
function activeJob(state: V2RechargeJob['state'], result: V2RechargeJob['result'] = {}) {
  const job: V2RechargeJob = {
    id: '11111111-1111-4111-8111-111111111111',
    plan: 'plus',
    action: 'flow',
    state,
    result,
    createdAt: '',
    updatedAt: ''
  };
  data.value.items = [job];
  return data.value.items[0]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  scope = effectScope();
  data.value = { configured: true, items: [] };
  addressData.value = {
    items: [address],
    total: 1,
    page: 1,
    pageSize: 2000,
    totals: { unused: 1, used: 0, disabled: 0 }
  };
  phase.value = 'ready';
  addressPhase.value = 'ready';
  mock.query = { data, phase, error: ref(null), refresh: vi.fn().mockResolvedValue(undefined) };
  mock.addressQuery = {
    data: addressData,
    phase: addressPhase,
    error: ref(null),
    refresh: vi.fn().mockResolvedValue(undefined)
  };
  mock.listAddresses.mockResolvedValue(addressData.value);
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
  mock.submitDetails.mockResolvedValue(undefined);
  mock.confirm.mockResolvedValue(undefined);
  mock.cancel.mockResolvedValue(undefined);
  flow = scope.run(useAutoRecharge)!;
});
afterEach(() => scope.stop());

describe('explicit auto recharge flow', () => {
  it('loads JSON locally and starts no network flow until the explicit button is used', async () => {
    session();
    flow.plan.value = 'plus';
    await nextTick();
    expect(mock.start).not.toHaveBeenCalled();
    expect(flow.canStartFlow.value).toBe(true);
    await flow.startFlow();
    expect(mock.start).toHaveBeenCalledTimes(1);
    expect(mock.start.mock.calls[0][0]).toMatchObject({ action: 'flow', plan: 'plus' });
    expect(mock.start.mock.calls[0][0].details).toBeUndefined();
  });

  it('polls only while server-side work can change without user input', () => {
    const getRevalidateAt = mock.jobOptions?.getRevalidateAt;
    expect(getRevalidateAt?.({ configured: true, items: [] })).toBeNull();
    expect(getRevalidateAt?.({ configured: true, items: [activeJob('running')] })).toBe(
      Date.now() + 2000
    );
    expect(
      getRevalidateAt?.({ configured: true, items: [activeJob('awaiting_details')] })
    ).toBeNull();
    expect(
      getRevalidateAt?.({ configured: true, items: [activeJob('awaiting_confirmation')] })
    ).toBeNull();
  });

  it('accepts billing-required as a checkpoint and submits details only on explicit click', async () => {
    const job = activeJob('awaiting_details', {
      status: 'checkout_ready_for_billing',
      account_matched: true,
      initial_quote: { ...quote, today: null, tax: null }
    });
    selectAddress();
    await nextTick();
    expect(flow.canSubmitDetails.value).toBe(true);
    expect(mock.submitDetails).not.toHaveBeenCalled();
    await flow.submitPaymentDetails();
    expect(mock.submitDetails).toHaveBeenCalledOnce();
    expect(mock.submitDetails).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        addressId: address.id,
        details: expect.objectContaining(completeDetails)
      })
    );
    expect(flow.details.value.number).toBe(completeDetails.number);
    expect(flow.details.value.expiry).toBe(completeDetails.expiry);
    expect(flow.details.value.cvc).toBe(completeDetails.cvc);
  });

  it('retains sensitive fields on preparation failure and clears them only after final quote', async () => {
    const job = activeJob('awaiting_details', { initial_quote: quote });
    selectAddress();
    await nextTick();
    mock.submitDetails.mockRejectedValueOnce(new Error('official form failed'));
    await flow.submitPaymentDetails();
    expect(flow.details.value.number).toBe(completeDetails.number);
    expect(flow.canSubmitDetails.value).toBe(true);
    await flow.submitPaymentDetails();
    expect(mock.submitDetails).toHaveBeenCalledTimes(2);
    job.state = 'finished';
    job.result = { status: 'blocked', reason: 'browser_operation_failed' };
    await nextTick();
    expect(flow.details.value.cvc).toBe(completeDetails.cvc);
    job.state = 'awaiting_confirmation';
    job.result = {
      quote,
      quote_authority: 'official_checkout_response',
      nonce: 'a'.repeat(64)
    };
    await nextTick();
    expect(flow.details.value.number).toBe('');
    expect(flow.details.value.expiry).toBe('');
    expect(flow.details.value.cvc).toBe('');
  });

  it('requires complete authoritative final quote before one confirmation', async () => {
    const job = activeJob('awaiting_confirmation', { quote, nonce: 'a'.repeat(64) });
    await nextTick();
    expect(flow.canConfirm.value).toBe(false);
    job.result.quote_authority = 'official_checkout_response';
    await nextTick();
    expect(flow.canConfirm.value).toBe(true);
    await flow.confirmPayment();
    await flow.confirmPayment();
    expect(mock.confirm).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a finished historical task as the current flow', async () => {
    activeJob('finished', { quote, nonce: 'a'.repeat(64) });
    expect(flow.selected.value).toBeUndefined();
    await flow.confirmPayment();
    expect(mock.confirm).not.toHaveBeenCalled();
  });

  it('only creates a read-only recheck for an unknown payment', async () => {
    session();
    flow.plan.value = 'plus';
    await nextTick();
    await flow.startFlow();
    const job = data.value.items[0]!;
    job.state = 'unknown';
    job.result = { payment_attempted: true, payment_status: 'unknown' };
    await nextTick();
    expect(flow.selected.value?.id).toBe(job.id);
    expect(flow.canRecheck.value).toBe(true);
    await flow.recheckPayment();
    expect(mock.start.mock.calls[1][0].action).toBe('recheck');
    expect(mock.confirm).not.toHaveBeenCalled();
  });

  it('clears secrets on successful cancel and on leaving the page', async () => {
    activeJob('awaiting_details', { initial_quote: quote });
    selectAddress();
    await flow.cancel();
    expect(flow.details.value.number).toBe('');
    flow.details.value = { ...completeDetails };
    scope.stop();
    expect(flow.sessionJson.value).toBe('');
    expect(Object.values(flow.details.value).every((value) => value === '')).toBe(true);
  });

  it('loads only unused addresses and applies the fixed location', async () => {
    const signal = new AbortController().signal;
    await mock.addressOptions!.query({ signal });
    expect(mock.listAddresses).toHaveBeenCalledWith(
      { page: 1, pageSize: 2000, status: 'unused' },
      { signal }
    );
    flow.selectedAddressId.value = address.id;
    expect(flow.details.value).toMatchObject({
      country: 'US',
      line1: address.line1,
      city: 'Portland',
      state: 'OR',
      postal_code: '97204'
    });
  });
});
