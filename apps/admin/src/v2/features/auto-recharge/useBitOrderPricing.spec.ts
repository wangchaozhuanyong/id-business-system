import { createRenderer, h } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearV2QueryCache, getV2QueryData } from '@/v2/composables/useV2Query';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import type { BitOrderPricingSettings } from './bank-recharge-api';
import { useBitOrderPricing } from './useBitOrderPricing';

const api = vi.hoisted(() => ({ read: vi.fn(), update: vi.fn(), rates: vi.fn() }));
vi.mock('./bank-recharge-api', () => ({
  bankRechargeApi: {
    orderPricingSettings: api.read,
    updateOrderPricingSettings: api.update,
    orderPricingRates: api.rates
  }
}));
vi.mock('@/v2/services/elementPlusMessage', () => ({ ElMessage: { success: vi.fn() } }));

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
const settings = (shoppingFeePercent: string): BitOrderPricingSettings => ({
  receivedCurrencyCode: 'CNY',
  shoppingFeePercent,
  usdtFeePercent: '1',
  planPrices: { plus: '100' },
  updatedAt: `2026-10-11T00:00:0${shoppingFeePercent}Z`
});
let app: ReturnType<typeof renderer.createApp> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  clearV2QueryCache();
  clearV2SessionDrafts();
  api.read.mockResolvedValue(settings('2'));
  api.rates.mockResolvedValue({ items: [] });
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  clearV2QueryCache();
  clearV2SessionDrafts();
});

async function mountPricing() {
  let flow!: ReturnType<typeof useBitOrderPricing>;
  app = renderer.createApp({
    setup() {
      flow = useBitOrderPricing();
      return () => h('div');
    }
  });
  app.mount(node());
  await vi.waitFor(() => expect(flow.query.data.value).toEqual(settings('2')));
  return flow;
}

describe('pricing settings module cache updates', () => {
  it('updates the mounted pricing query after save without a second read', async () => {
    const flow = await mountPricing();
    api.update.mockResolvedValue(settings('3'));
    flow.draft.form.shoppingFeePercent = '3';

    await flow.save();

    expect(flow.query.data.value).toEqual(settings('3'));
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(
      getV2QueryData('auto-recharge', 'bit-orders-pricing-settings', {
        moduleKey: 'bank-recharge-orders'
      })
    ).toEqual(settings('3'));
    expect(getV2QueryData('auto-recharge', 'bit-orders-pricing-settings')).toBeUndefined();
  });

  it('updates the same mounted query when saved settings are explicitly reloaded', async () => {
    const flow = await mountPricing();
    api.read.mockResolvedValueOnce(settings('4'));

    await flow.reloadSaved();

    expect(flow.query.data.value).toEqual(settings('4'));
    expect(flow.draft.form.shoppingFeePercent).toBe('4');
    expect(api.read).toHaveBeenCalledTimes(2);
  });
});
