import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ref, ssrContextKey, type Component, type VNode } from 'vue';
import type { PublicTask } from './contracts';

const fixture = vi.hoisted(() => ({
  user: {
    id: 'synthetic-owner',
    username: 'fixture',
    displayName: '合成员工',
    roles: ['employee'],
    permissions: [] as string[],
    mustResetPassword: false
  },
  epoch: { value: 0 },
  listeners: new Set<() => void>(),
  verify: vi.fn(),
  redeem: vi.fn(),
  query: vi.fn(),
  stop: vi.fn()
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: fixture.user }) }));
vi.mock('@/auth/sessionCoordinator', () => ({
  sessionCoordinator: {
    identityEpoch: fixture.epoch,
    subscribeIdentityChange(callback: () => void) {
      fixture.listeners.add(callback);
      return () => fixture.listeners.delete(callback);
    }
  }
}));
vi.mock('./api', () => ({
  onlineApi: {
    verify: fixture.verify,
    redeem: fixture.redeem,
    query: fixture.query
  }
}));
vi.mock('./useOnlineTask', () => ({
  useOnlineTask: () => ({
    connected: ref(false),
    error: ref(''),
    stop: fixture.stop,
    refresh: vi.fn()
  })
}));
vi.mock('@/v2/composables/useV2Query', () => ({
  useV2ModuleQuery: () => ({
    phase: ref('ready'),
    error: ref(),
    data: ref({ available: true }),
    refresh: vi.fn()
  })
}));
import V2OnlineRedeemView from './V2OnlineRedeemView.vue';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';

type TestNode = { parent: TestNode | null; children: TestNode[] };
const node = (): TestNode => ({ parent: null, children: [] });
const renderer = createRenderer<TestNode, TestNode>({
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
type State = {
  code: string;
  session: string;
  message: string;
  failure: boolean;
  verified?: { plan: string; status: string };
  task?: PublicTask;
  token: string;
  canRead: boolean;
  canManage: boolean;
  verify: () => Promise<void>;
  redeem: () => Promise<void>;
};
const unmounts: (() => void)[] = [];
function mount() {
  let rendered!: VNode;
  const subject = { ...V2OnlineRedeemView, render: () => null } as Component;
  const app = renderer.createApp({ setup: () => () => (rendered = h(subject)) });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  let mounted = true;
  const unmount = () => {
    if (mounted) {
      mounted = false;
      app.unmount();
    }
  };
  unmounts.push(unmount);
  return {
    state: (rendered.component as unknown as { setupState: State }).setupState,
    unmount
  };
}
const synthetic = '{"accessToken":"synthetic-token-not-a-real-credential"}';
beforeEach(() => {
  vi.clearAllMocks();
  fixture.user.permissions = [
    'id_business_v2.online_recharge.read',
    'id_business_v2.online_recharge.manage'
  ];
  fixture.verify.mockResolvedValue({ plan: 'plus', status: 'available' });
  fixture.redeem.mockResolvedValue({
    id: 'synthetic-task',
    status: 'queued',
    taskToken: 'synthetic-task-token'
  });
});
afterEach(() => {
  unmounts.splice(0).forEach((unmount) => unmount());
  clearV2SessionDrafts();
});

describe('管理台兑换充值', () => {
  it('只读授权可读取，但调用提交方法也不能创建任务', async () => {
    fixture.user.permissions = ['id_business_v2.online_recharge.read'];
    const { state } = mount();
    state.code = 'SYNTHETIC-CODE';
    state.session = synthetic;
    state.verified = { plan: 'plus', status: 'available' };
    expect(state.canRead).toBe(true);
    expect(state.canManage).toBe(false);
    await state.redeem();
    expect(fixture.redeem).not.toHaveBeenCalled();
    expect(state.failure).toBe(true);
  });
  it('缺少读取权限时不显示兑换页', () => {
    fixture.user.permissions = [];
    expect(mount().state.canRead).toBe(false);
  });
  it('失败保留资料；成功保存原任务并清除临时会话', async () => {
    const { state } = mount();
    state.code = 'SYNTHETIC-CODE';
    state.session = synthetic;
    await state.verify();
    fixture.redeem.mockRejectedValueOnce(new Error('合成服务暂时不可用'));
    await state.redeem();
    expect(state.session).toBe(synthetic);
    expect(state.failure).toBe(true);
    await state.redeem();
    expect(state.session).toBe('');
    expect(state.task?.id).toBe('synthetic-task');
    expect(state.code).toBe('SYNTHETIC-CODE');
  });
  it('切页返回保留兑换码，临时会话不进入草稿', async () => {
    const first = mount();
    first.state.code = 'SYNTHETIC-CODE';
    first.state.session = synthetic;
    first.unmount();
    await nextTick();
    const second = mount();
    expect(second.state.code).toBe('SYNTHETIC-CODE');
    expect(second.state.session).toBe('');
  });
  it('身份更换清理兑换码、会话和原任务', async () => {
    const { state } = mount();
    state.code = 'SYNTHETIC-CODE';
    state.session = synthetic;
    await state.verify();
    await state.redeem();
    state.session = synthetic;
    fixture.epoch.value++;
    for (const listener of fixture.listeners) listener();
    await nextTick();
    expect(state.code).toBe('');
    expect(state.session).toBe('');
    expect(state.task).toBeUndefined();
    expect(state.token).toBe('');
    expect(fixture.stop).toHaveBeenCalled();
  });
  it('身份更换后迟到的提交响应不能恢复旧任务', async () => {
    let finish!: (task: unknown) => void;
    fixture.redeem.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const { state } = mount();
    state.code = 'SYNTHETIC-CODE';
    state.session = synthetic;
    await state.verify();
    const pending = state.redeem();
    fixture.epoch.value++;
    for (const listener of fixture.listeners) listener();
    finish({ id: 'synthetic-late-task', taskToken: 'synthetic-late-token' });
    await pending;
    expect(state.task).toBeUndefined();
    expect(state.token).toBe('');
    expect(state.session).toBe('');
  });
});
