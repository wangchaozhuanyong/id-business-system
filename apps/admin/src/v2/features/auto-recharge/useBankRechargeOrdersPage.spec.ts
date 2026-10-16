import { createRenderer, h, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearV2QueryCache } from '@/v2/composables/useV2Query';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import { useBankRechargeOrdersPage } from './useBankRechargeOrdersPage';
import type { BankRechargeOrder, RechargeOrderChannel } from './bank-recharge-api';
const api = vi.hoisted(() => ({
  list: vi.fn(),
  options: vi.fn(),
  cards: vi.fn(),
  accounts: vi.fn(),
  currencies: vi.fn(),
  update: vi.fn(),
  create: vi.fn()
}));
vi.mock('./bank-recharge-api', () => ({
  bankRechargeApi: {
    listOrders: api.list,
    orderOptions: api.options,
    listCards: api.cards,
    listAccounts: api.accounts,
    listCurrencies: api.currencies,
    updateOrder: api.update,
    createManualOrder: api.create
  }
}));
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ replace: vi.fn() })
}));
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ user: { id: 'operator', roles: ['admin'] } })
}));
vi.mock('@/v2/features/online-recharge/public-api', () => ({ canManageOnlineOrders: () => true }));
vi.mock('./useBitOrderPricing', () => ({ useBitOrderPricing: () => ({ applyDefaults: vi.fn() }) }));
vi.mock('./useBankRechargeOrderTiming', () => ({
  useBankRechargeOrderTiming: () => ({
    usageLabel: vi.fn(),
    usageTagType: vi.fn(),
    initializeDates: vi.fn()
  })
}));
vi.mock('@/v2/utils/formValidation', () => ({ validateV2Form: async () => true }));
vi.mock('@/v2/services/elementPlusMessage', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), info: vi.fn() }
}));
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
function mount(channel: RechargeOrderChannel) {
  let flow!: ReturnType<typeof useBankRechargeOrdersPage>;
  app = renderer.createApp({
    setup() {
      flow = useBankRechargeOrdersPage(channel);
      return () => h('div');
    }
  });
  app.mount(node());
  return flow;
}
const row = (channel: RechargeOrderChannel) =>
  ({
    id: 'same-row-id',
    orderNo: 'ORDER-1',
    channel,
    source: 'automatic',
    plan: 'plus',
    status: 'pending_details',
    financeStatus: 'unposted',
    accountingVersion: 'subscription_cost_v2',
    chargeAmount: null,
    chargeCurrencyCode: null,
    cardId: null,
    onlineRechargeCardId: channel === 'online' ? 'online-card' : null,
    customerFeeRate: '0',
    customerFeeAmount: '0',
    updatedAt: '2026-10-15T00:00:00.000Z'
  }) as BankRechargeOrder;
beforeEach(() => {
  vi.clearAllMocks();
  clearV2QueryCache();
  clearV2SessionDrafts();
  api.list.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    evaluatedAt: '2026-10-15T00:00:00.000Z',
    revalidateAt: '2099-01-01T00:00:00.000Z'
  });
  api.options.mockImplementation((_options, channel) =>
    Promise.resolve({
      customers: [],
      financeAccounts: [],
      cards:
        channel === 'online'
          ? [{ id: 'online-card', label: '线上卡', last4: '1234', currencyCode: '', active: true }]
          : []
    })
  );
  api.accounts.mockResolvedValue({ items: [] });
  api.cards.mockResolvedValue({ items: [] });
  api.currencies.mockResolvedValue({ items: [] });
  api.update.mockResolvedValue({});
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  clearV2QueryCache();
  clearV2SessionDrafts();
});
describe('充值订单渠道隔离', () => {
  it('筛选、页码、编辑与退款草稿在双渠道切换后分别恢复', async () => {
    let flow = mount('bitbrowser');
    flow.keywordInput.value = '比特客户';
    flow.applyFilters();
    flow.page.value = 3;
    flow.openCreate();
    flow.form.chargeAmount = '123';
    flow.openRefund(row('bitbrowser'));
    flow.refund.reason = '比特退款草稿';
    await nextTick();
    app!.unmount();
    app = undefined;
    flow = mount('online');
    expect(flow.keywordInput.value).toBe('');
    expect(flow.page.value).toBe(1);
    flow.openCreate();
    expect(flow.form.chargeAmount).toBe('');
    flow.form.chargeAmount = '888';
    flow.openRefund(row('online'));
    expect(flow.refund.reason).toBe('');
    flow.refund.reason = '线上退款草稿';
    await nextTick();
    app!.unmount();
    app = undefined;
    flow = mount('bitbrowser');
    expect(flow.keywordInput.value).toBe('比特客户');
    expect(flow.page.value).toBe(3);
    flow.openCreate();
    expect(flow.form.chargeAmount).toBe('123');
    flow.openRefund(row('bitbrowser'));
    expect(flow.refund.reason).toBe('比特退款草稿');
    app!.unmount();
    app = undefined;
    flow = mount('online');
    flow.openCreate();
    expect(flow.form.chargeAmount).toBe('888');
    flow.openRefund(row('online'));
    expect(flow.refund.reason).toBe('线上退款草稿');
  });
  it('线上未知实付不填默认币种，只使用线上卡池并发送线上卡关联', async () => {
    const flow = mount('online');
    flow.openEdit(row('online'));
    expect(flow.form.chargeAmount).toBe('');
    expect(flow.form.chargeCurrencyCode).toBe('');
    expect(flow.form.cardId).toBe('online-card');
    await vi.waitFor(() => expect(flow.availableCards.value).toHaveLength(1));
    flow.form.chargeAmount = '25';
    flow.form.chargeCurrencyCode = 'PHP';
    flow.form.paymentEvidenceRef = 'MANUAL-REFERENCE';
    await flow.save();
    expect(api.update).toHaveBeenCalledWith(
      'same-row-id',
      expect.objectContaining({
        onlineRechargeCardId: 'online-card',
        chargeAmount: '25',
        chargeCurrencyCode: 'PHP',
        paymentEvidenceRef: 'MANUAL-REFERENCE'
      })
    );
    expect(api.update.mock.calls[0]![1]).not.toHaveProperty('cardId');
  });
  it('线上补核币种保留已耗尽的原执行卡，手工录入不允许另选已耗尽卡', async () => {
    api.options.mockResolvedValue({
      customers: [],
      financeAccounts: [],
      cards: [
        {
          id: 'online-card',
          label: '原执行卡',
          last4: '1234',
          currencyCode: '',
          active: true,
          status: 'exhausted'
        },
        {
          id: 'other-card',
          label: '其他耗尽卡',
          last4: '5678',
          currencyCode: '',
          active: true,
          status: 'exhausted'
        }
      ]
    });
    const flow = mount('online');
    flow.openEdit(row('online'));
    await vi.waitFor(() => expect(flow.availableCards.value).toHaveLength(1));
    expect(flow.availableCards.value[0]!.id).toBe('online-card');
    flow.form.chargeCurrencyCode = 'PHP';
    flow.form.chargeFxRateToCny = '0.1';
    flow.changeChargeCurrency();
    expect(flow.form.cardId).toBe('online-card');
    expect(flow.form.chargeFxRateToCny).toBe('');
    flow.openCreate();
    expect(flow.availableCards.value).toEqual([]);
  });
  it('比特订单切换币种保留通用银行卡，重新填写对应汇率', () => {
    const flow = mount('bitbrowser');
    flow.openEdit(row('bitbrowser'));
    flow.form.cardId = 'bit-card';
    flow.form.chargeFxRateToCny = '0.1';
    flow.changeChargeCurrency();
    expect(flow.form.cardId).toBe('bit-card');
    expect(flow.form.chargeFxRateToCny).toBe('');
  });
  it('比特订单加载不同登记币种的启用银行卡', async () => {
    api.options.mockResolvedValue({ customers: [], financeAccounts: [] });
    api.cards.mockResolvedValue({
      items: [
        { id: 'bit-card', label: '比特卡', last4: '1234', currencyCode: 'PHP', active: true },
        { id: 'usd-card', label: '美元卡', last4: '5678', currencyCode: 'USD', active: true }
      ]
    });
    const flow = mount('bitbrowser');
    flow.openCreate();
    await vi.waitFor(() => expect(flow.availableCards.value).toHaveLength(2));
    expect(flow.availableCards.value.map((card) => card.id)).toEqual(['bit-card', 'usd-card']);
    expect(api.cards).toHaveBeenCalledTimes(1);
  });
  it('线上订单只从线上选项卡池加载，不请求原比特银行卡库', async () => {
    const flow = mount('online');
    flow.openEdit(row('online'));
    await vi.waitFor(() => expect(flow.availableCards.value).toHaveLength(1));
    expect(flow.availableCards.value[0]!.id).toBe('online-card');
    expect(api.cards).not.toHaveBeenCalled();
  });
  it('切换期间迟到的手工录入结果不能打开另一渠道编辑器或覆盖新草稿', async () => {
    let resolve!: (value: BankRechargeOrder) => void;
    api.create.mockImplementation(
      () =>
        new Promise((finish) => {
          resolve = finish;
        })
    );
    const bit = mount('bitbrowser');
    bit.openCreate();
    bit.form.chargeAmount = '123';
    const pending = bit.save();
    await vi.waitFor(() => expect(api.create).toHaveBeenCalled());
    app!.unmount();
    app = undefined;
    const online = mount('online');
    online.openCreate();
    online.form.chargeAmount = '888';
    resolve(row('bitbrowser'));
    await pending;
    expect(online.creating.value).toBe(true);
    expect(online.form.chargeAmount).toBe('888');
    expect(online.selected.value).toBeNull();
  });
});
