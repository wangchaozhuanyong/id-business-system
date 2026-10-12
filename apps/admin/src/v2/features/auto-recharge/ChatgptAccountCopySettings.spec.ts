import { createRenderer, effectScope, h, ssrContextKey, type EffectScope } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import {
  clearV2QueryCache,
  getV2QueryData,
  useV2Query,
  type UseV2QueryResult
} from '@/v2/composables/useV2Query';
import { clearV2SessionDrafts, useV2FormDraft } from '@/v2/composables/useV2SessionDraft';
import ChatgptAccountCopySettings from './ChatgptAccountCopySettings.vue';

const api = vi.hoisted(() => ({ read: vi.fn(), update: vi.fn() }));
vi.mock('./bank-recharge-api', () => ({
  bankRechargeApi: { accountCopySettings: api.read, updateAccountCopySettings: api.update }
}));
vi.mock('@/v2/services/elementPlusMessage', () => ({ ElMessage: { success: vi.fn() } }));
vi.mock('@/components/ui/AppButton.vue', () => ({ default: {} }));
vi.mock('@/v2/components/V2FormDrawer.vue', () => ({ default: {} }));
vi.mock('@/v2/components/V2AsyncRegion.vue', () => ({ default: {} }));

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
let consumerScope: EffectScope | undefined;
interface CopySettingsFlow {
  draft: ReturnType<typeof useV2FormDraft<{ suffix: string }>>;
  query: UseV2QueryResult<{ suffix: string }>;
  openSettings: () => Promise<void>;
  save: () => Promise<void>;
}
afterEach(() => {
  app?.unmount();
  consumerScope?.stop();
  clearV2QueryCache();
  clearV2SessionDrafts();
});

it('updates the mounted copy-settings cache with the server value after saving', async () => {
  clearV2QueryCache();
  clearV2SessionDrafts();
  vi.clearAllMocks();
  api.read.mockResolvedValue({ suffix: '原后缀' });
  api.update.mockResolvedValue({ suffix: '服务器保存后缀' });
  // Exercise the actual setup/save flow; UI rendering is irrelevant to cache publication.
  app = renderer.createApp({ ...ChatgptAccountCopySettings, render: () => h('div') });
  app.provide(ssrContextKey, {});
  app.mount(node());
  const instance = app._instance as unknown as { setupState: CopySettingsFlow };
  const flow = instance.setupState;
  await flow.openSettings();
  expect(flow.query.data.value).toEqual({ suffix: '原后缀' });
  consumerScope = effectScope();
  const observer = consumerScope.run(() =>
    useV2Query<{ suffix: string }>({
      moduleKey: 'chatgpt-accounts',
      scope: 'auto-recharge',
      key: 'chatgpt-account-copy-settings',
      query: api.read
    })
  )!;
  flow.draft.form.suffix = '提交后缀';

  await flow.save();

  expect(api.update).toHaveBeenCalledWith('提交后缀');
  expect(observer.data.value).toEqual({ suffix: '服务器保存后缀' });
  expect(
    getV2QueryData('auto-recharge', 'chatgpt-account-copy-settings', {
      moduleKey: 'chatgpt-accounts'
    })
  ).toEqual({ suffix: '服务器保存后缀' });
  expect(getV2QueryData('auto-recharge', 'chatgpt-account-copy-settings')).toBeUndefined();
});
