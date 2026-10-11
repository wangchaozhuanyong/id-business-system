import { createRenderer, h, nextTick, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { clearV2QueryCache } from '@/v2/composables/useV2Query';
import { clearV2SessionDrafts, useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { useExchangeRatesPage } from './useExchangeRatesPage';

const api = vi.hoisted(() => ({ bootstrap: vi.fn(), manual: vi.fn(), purchase: vi.fn() }));
vi.mock('./api', () => ({
  idBusinessV2ExchangeRatesApi: {
    bootstrap: api.bootstrap,
    listManualRates: api.manual,
    listPurchaseQuotes: api.purchase,
    overview: vi.fn(),
    runtime: vi.fn()
  }
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: null }) }));
vi.mock('@/v2/services/elementPlusMessage', () => ({ ElMessage: { success: vi.fn() } }));
vi.mock('./usePurchaseQuoteEditor', () => ({ usePurchaseQuoteEditor: () => ({}) }));
vi.mock('./usePurchaseRateAutomation', () => ({ usePurchaseRateAutomation: () => ({}) }));

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
afterEach(() => {
  app?.unmount();
  clearV2QueryCache();
  clearV2SessionDrafts();
});

it('reuses bootstrap manual and purchase snapshots when switching tabs without extra reads', async () => {
  clearV2QueryCache();
  clearV2SessionDrafts();
  vi.clearAllMocks();
  const result = {
    overview: { effective: { expiresAt: null }, lastSuccess: null },
    runtime: {},
    runs: { items: [], total: 0, page: 1, pageSize: 10 },
    records: { items: [], total: 0, page: 1, pageSize: 20 },
    manualEntries: { items: [{ id: 'manual-fixture' }], total: 1, page: 1, pageSize: 20 },
    purchaseQuotes: { items: [{ id: 'purchase-fixture', latestSnapshot: null }] }
  };
  api.bootstrap.mockResolvedValue(result);
  api.manual.mockRejectedValue(new Error('人工页应命中预热缓存'));
  api.purchase.mockRejectedValue(new Error('采购页应命中预热缓存'));
  useV2SessionDraft('exchange-rates/useExchangeRatesPage:activeTab', () => ref('automatic'));
  let page!: ReturnType<typeof useExchangeRatesPage>;
  app = renderer.createApp({
    setup() {
      page = useExchangeRatesPage();
      return () => h('div');
    }
  });
  app.mount(node());
  await vi.waitFor(() => expect(page.recordResolved.value).toBe(true));

  page.activeTab.value = 'manual';
  await nextTick();
  await vi.waitFor(() => expect(page.queryPhase.value).toBe('ready'));
  expect(page.manualEntries.value).toEqual(result.manualEntries.items);
  expect(api.manual).not.toHaveBeenCalled();

  page.activeTab.value = 'purchase';
  await nextTick();
  await vi.waitFor(() => expect(page.queryPhase.value).toBe('ready'));
  expect(page.purchaseQuotes.value).toEqual(result.purchaseQuotes.items);
  expect(api.purchase).not.toHaveBeenCalled();
  expect(api.bootstrap).toHaveBeenCalledTimes(1);
});
