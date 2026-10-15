import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ref, ssrContextKey, type Component, type VNode } from 'vue';
import type { FormValue, OnlineAction, OnlineField, OnlineSection } from './contracts';

const identity = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  epoch: { value: 0 }
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: { id: 'synthetic-owner' } }) }));
vi.mock('@/auth/sessionCoordinator', () => ({
  sessionCoordinator: {
    identityEpoch: identity.epoch,
    subscribeIdentityChange(callback: () => void) {
      identity.listeners.add(callback);
      return () => identity.listeners.delete(callback);
    }
  }
}));
vi.mock('./api', () => ({ onlineApi: { action: vi.fn() } }));
vi.mock('@/v2/components/V2FormDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h('drawer', slots.default?.())
    })
  };
});
import OnlineActionDrawer from './OnlineActionDrawer.vue';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';

type TestNode = {
  type: string;
  props: Record<string, unknown>;
  children: TestNode[];
  parent: TestNode | null;
};
const node = (type = ''): TestNode => ({ type, props: {}, children: [], parent: null });
const renderer = createRenderer<TestNode, TestNode>({
  patchProp: (element, key, _previous, value) => {
    element.props[key] = value;
  },
  insert(child, parent) {
    child.parent = parent;
    parent.children.push(child);
  },
  remove(child) {
    if (child.parent)
      child.parent.children = child.parent.children.filter((item) => item !== child);
  },
  createElement: node,
  createText: () => node(),
  createComment: () => node(),
  setText: () => undefined,
  setElementText: () => undefined,
  parentNode: (child) => child.parent,
  nextSibling: () => null
});
const unmounts: (() => void)[] = [];
afterEach(() => {
  unmounts.splice(0).forEach((unmount) => unmount());
  clearV2SessionDrafts();
});

function mountDrawer(section: OnlineSection, field: 'session' | 'cvc') {
  const open = ref(true);
  const action = ref<OnlineAction>({
    key: field === 'session' ? 'start' : 'cvc',
    label: '合成测试操作',
    fields: [{ key: field, label: '合成临时资料', transient: true, type: 'secret' }]
  });
  const root = node();
  let rendered!: VNode;
  // Exercise the actual SFC setup with Vue's renderer; no browser or website starts.
  const subject = { ...OnlineActionDrawer, render: () => null } as Component;
  const app = renderer.createApp({
    setup: () => () =>
      (rendered = h(subject, { modelValue: open.value, section, action: action.value }))
  });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(root);
  unmounts.push(() => app.unmount());
  const state = () =>
    (
      rendered.component as unknown as {
        setupState: {
          value: (key: string) => FormValue;
          setValue: (field: OnlineField, value: FormValue) => void;
        };
      }
    ).setupState;
  return {
    open,
    action,
    read: () => state().value(field),
    async fill(value: string) {
      state().setValue(action.value.fields![0], value);
      await nextTick();
    }
  };
}

describe.each([
  ['checkout-debug', 'session', '{"accessToken":"synthetic-token-not-a-real-credential"}'],
  ['cards', 'cvc', '123']
] as const)('线上代充 %s 临时输入生命周期', (section, field, synthetic) => {
  it('相同动作的配置对象重建后保留已填临时资料', async () => {
    const drawer = mountDrawer(section, field);
    await drawer.fill(synthetic);
    drawer.action.value = {
      ...drawer.action.value,
      label: '刷新后的合成操作',
      fields: drawer.action.value.fields?.map((item) => ({ ...item }))
    };
    await nextTick();
    expect(drawer.read()).toBe(synthetic);
  });
  it('关闭重开后清除临时资料', async () => {
    const drawer = mountDrawer(section, field);
    await drawer.fill(synthetic);
    drawer.open.value = false;
    await nextTick();
    expect(drawer.read()).toBe('');
    drawer.open.value = true;
    await nextTick();
    expect(drawer.read()).toBe('');
  });
  it('切换身份后清除临时资料', async () => {
    const drawer = mountDrawer(section, field);
    await drawer.fill(synthetic);
    identity.epoch.value++;
    for (const callback of identity.listeners) callback();
    await nextTick();
    expect(drawer.read()).toBe('');
  });
  it('真正更换动作后清除临时资料', async () => {
    const drawer = mountDrawer(section, field);
    await drawer.fill(synthetic);
    drawer.action.value = { ...drawer.action.value, key: 'synthetic-other-action' };
    await nextTick();
    expect(drawer.read()).toBe('');
  });
});
