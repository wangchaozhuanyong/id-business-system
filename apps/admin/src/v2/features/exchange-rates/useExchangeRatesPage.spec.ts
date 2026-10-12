import { createRenderer, h, nextTick, ref } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import {
  clearV2QueryCache,
  createV2QueryKey,
  getV2QueryData,
  primeV2Query
} from '@/v2/composables/useV2Query';
import { clearV2SessionDrafts, useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { useExchangeRatesPage } from './useExchangeRatesPage';

const api = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  manual: vi.fn(),
  purchase: vi.fn(),
  overview: vi.fn(),
  runtime: vi.fn()
}));
vi.mock('./api', () => ({
  idBusinessV2ExchangeRatesApi: {
    bootstrap: api.bootstrap,
    listManualRates: api.manual,
    listPurchaseQuotes: api.purchase,
    overview: api.overview,
    runtime: api.runtime
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
beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  app?.unmount();
  app = undefined;
  clearV2QueryCache();
  clearV2SessionDrafts();
  vi.useRealTimers();
});

it.each(['identity-switch', 'cancel'] as const)(
  'does not prime late bootstrap snapshots after %s',
  async (reason) => {
    let complete!: (value: unknown) => void;
    api.bootstrap
      .mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve;
        })
      )
      .mockReturnValue(new Promise(() => {}));
    useV2SessionDraft('exchange-rates/useExchangeRatesPage:activeTab', () => ref('automatic'));
    app = renderer.createApp({
      setup() {
        useExchangeRatesPage();
        return () => h('div');
      }
    });
    app.mount(node());
    await vi.waitFor(() => expect(api.bootstrap).toHaveBeenCalledTimes(1));
    if (reason === 'identity-switch')
      sessionCoordinator.clearLocalSession({ reason: 'identity-switched' });
    else clearV2QueryCache();
    expect(api.bootstrap.mock.calls[0]![1].signal.aborted).toBe(true);
    const purchaseKey = createV2QueryKey({ tab: 'purchase', query: undefined });
    primeV2Query({
      moduleKey: 'exchange-rates',
      scope: 'exchange-rates',
      key: purchaseKey,
      data: 'current-identity'
    });
    complete({
      overview: { effective: { expiresAt: null }, lastSuccess: null },
      runtime: {},
      purchaseQuotes: { items: [] }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getV2QueryData('exchange-rates', purchaseKey, { moduleKey: 'exchange-rates' })).toBe(
      'current-identity'
    );
  }
);

it('reads again when a primed purchase snapshot expires while its tab is inactive', async () => {
  vi.useFakeTimers();
  const now = Date.now();
  const initial = {
    overview: { effective: { expiresAt: new Date(now + 1_000).toISOString() }, lastSuccess: null },
    runtime: {},
    records: { items: [], total: 0, page: 1, pageSize: 20 },
    purchaseQuotes: { items: [{ id: 'expired-purchase', latestSnapshot: null }] }
  };
  api.bootstrap.mockResolvedValue(initial);
  api.overview.mockResolvedValue({ effective: { expiresAt: null }, lastSuccess: null });
  api.runtime.mockResolvedValue({});
  api.purchase.mockResolvedValue({ items: [{ id: 'fresh-purchase', latestSnapshot: null }] });
  const tab = useV2SessionDraft('exchange-rates/useExchangeRatesPage:activeTab', () =>
    ref('automatic')
  );
  let page!: ReturnType<typeof useExchangeRatesPage>;
  function mount() {
    app = renderer.createApp({
      setup() {
        page = useExchangeRatesPage();
        return () => h('div');
      }
    });
    app.mount(node());
  }
  mount();
  await vi.waitFor(() => expect(page.recordResolved.value).toBe(true));
  const key = createV2QueryKey({ tab: 'purchase', query: undefined });
  expect(getV2QueryData('exchange-rates', key, { moduleKey: 'exchange-rates' })).toBeDefined();
  app!.unmount();
  app = undefined;
  await vi.advanceTimersByTimeAsync(1_001);
  expect(getV2QueryData('exchange-rates', key, { moduleKey: 'exchange-rates' })).toBeUndefined();
  tab.value = 'purchase';
  mount();
  await vi.waitFor(() => expect(page.queryPhase.value).toBe('ready'));
  expect(api.purchase).toHaveBeenCalledTimes(1);
  expect(page.purchaseQuotes.value).toEqual([{ id: 'fresh-purchase', latestSnapshot: null }]);
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
