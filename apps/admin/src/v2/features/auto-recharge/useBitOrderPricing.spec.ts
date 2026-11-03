import { afterEach, expect, it, vi } from 'vitest';
import { createRenderer } from 'vue';
import { clearV2QueryCache } from '@/v2/composables/useV2Query';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import { useBitOrderPricing } from './useBitOrderPricing';

const api = vi.hoisted(() => ({ settings: vi.fn(), rates: vi.fn() }));
vi.mock('./bank-recharge-api', () => ({
  bankRechargeApi: { orderPricingSettings: api.settings, orderPricingRates: api.rates }
}));
vi.mock('@/v2/services/elementPlusMessage', () => ({ ElMessage: { success: vi.fn() } }));
const renderer = createRenderer<object, object>({
  patchProp() {},
  insert() {},
  remove() {},
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  setText() {},
  setElementText() {},
  parentNode: () => null,
  nextSibling: () => null
});
let app: ReturnType<typeof renderer.createApp> | undefined;
afterEach(() => {
  app?.unmount();
  clearV2QueryCache();
  clearV2SessionDrafts();
  vi.clearAllMocks();
});

it('keeps settings and rates available for list cost previews before any editor opens', async () => {
  api.settings.mockResolvedValue({ planPrices: {}, updatedAt: null });
  api.rates.mockResolvedValue({ items: [] });
  let pricing!: ReturnType<typeof useBitOrderPricing>;
  app = renderer.createApp({
    setup() {
      pricing = useBitOrderPricing();
      return () => null;
    }
  });
  app.mount({});
  expect(pricing.open.value).toBe(false);
  await vi.waitFor(() => {
    expect(api.settings).toHaveBeenCalledOnce();
    expect(api.rates).toHaveBeenCalledOnce();
  });
  expect(pricing.open.value).toBe(false);
});
