import { computed, effectScope, nextTick, ref, watch } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { useRechargeBrowserSettings } from './useRechargeBrowserSettings';
import type { V2RechargeBitBrowserSettings } from './contracts';

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), catalog: vi.fn() }));
vi.mock('./api', () => ({
  rechargeApi: {
    getBitBrowserSettings: mocks.get,
    updateBitBrowserSettings: mocks.save
  }
}));
vi.mock('./useRechargeBrowserCatalog', () => ({
  readBrowserCatalog: mocks.catalog,
  useRechargeBrowserCatalog: () => ({ selectionError: ref(''), catalogReady: ref(true) })
}));
vi.mock('./useManagedBrowserProxy', () => ({
  useManagedBrowserProxy: () => ({
    error: ref(''),
    query: { phase: ref('ready') }
  })
}));
vi.mock('@/v2/composables/useV2Query', () => ({
  useV2ModuleQuery: (options: {
    key: () => string;
    query: (context: { signal: AbortSignal }) => Promise<unknown>;
  }) => {
    const data = ref();
    const error = ref();
    const phase = ref('initial-loading');
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      try {
        const result = await options.query({ signal: new AbortController().signal });
        if (current === revision) {
          data.value = result;
          error.value = undefined;
          phase.value = 'ready';
        }
      } catch (failure) {
        if (current === revision) error.value = failure;
      }
    };
    watch(options.key, refresh, { immediate: true });
    return { data, error, phase, refresh };
  }
}));
const profileA = '11111111-1111-4111-8111-111111111111';
const profileB = '22222222-2222-4222-8222-222222222222';
const fixture = (id: string | null = null): V2RechargeBitBrowserSettings => ({
  connectionProfileId: id,
  connectionProfileName: id === profileA ? '电脑甲' : '电脑乙',
  connectionProfiles: [
    { id: profileA, name: '电脑甲' },
    { id: profileB, name: '电脑乙' }
  ],
  connectorUrl: 'http://127.0.0.1:55322',
  localApiUrl: 'http://127.0.0.1:54345',
  localApiTokenConfigured: true,
  localApiTokenMask: '已配置',
  connectorTokenConfigured: true,
  connectorTokenMask: '已配置',
  groupName: id === profileA ? '甲分组' : '乙分组',
  tagName: '标签',
  proxyType: 'http',
  dynamicProxyUrlConfigured: true,
  dynamicProxyUrlMask: '已配置',
  browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS },
  updatedAt: '2026-10-12T00:00:00.000Z'
});
const settle = async () => {
  await nextTick();
  await Promise.resolve();
  await nextTick();
};
const create = (direct = false) => {
  const scope = effectScope();
  const settings = scope.run(() =>
    useRechargeBrowserSettings(
      ref('unknown'),
      ref(''),
      ref(false),
      computed(() => direct)
    )
  )!;
  return { settings, stop: () => scope.stop() };
};
beforeEach(() => {
  clearV2SessionDrafts();
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (_options, id) => fixture(id ?? null));
  mocks.catalog.mockImplementation(async (form) => ({
    groups: [{ name: form.groupName }],
    tags: [{ name: form.tagName }]
  }));
});
describe('按连接配置隔离设置草稿', () => {
  it('配置甲的未保存输入、原始版本与配置乙分别保留，关闭重开也保留', async () => {
    const first = create();
    await settle();
    first.settings.connectionProfileChoice.value = profileA;
    await settle();
    first.settings.settingsForm.value.groupName = '甲的未保存输入';
    first.settings.connectionProfileChoice.value = profileB;
    await settle();
    expect(first.settings.settingsForm.value.groupName).toBe('乙分组');
    first.settings.settingsForm.value.groupName = '乙的未保存输入';
    first.settings.connectionProfileChoice.value = profileA;
    await settle();
    expect(first.settings.settingsForm.value.groupName).toBe('甲的未保存输入');
    first.stop();
    const reopened = create();
    await settle();
    expect(reopened.settings.settingsForm.value.groupName).toBe('甲的未保存输入');
    reopened.stop();
  });
  it('新增配置要求重新填写秘密，不沿用旧配置的已配置状态', async () => {
    const { settings, stop } = create();
    await settle();
    settings.connectionProfileChoice.value = 'new';
    expect(settings.settingsForm.value.newConnectionProfile).toBe(true);
    expect(settings.storedSettings.value?.localApiTokenConfigured).toBe(false);
    expect(settings.storedSettings.value?.connectorTokenConfigured).toBe(false);
    expect(settings.settingsForm.value.groupName).toBe('');
    expect(settings.settingsForm.value.tagName).toBe('');
    await settings.saveSettings();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(settings.settingsError.value).toContain('连接密钥');
    stop();
  });
  it('整页刷新后读取当前系统账号已保存的连接与参数，不强制退回原连接', async () => {
    mocks.get.mockImplementation(async (_options, id) => fixture(id === undefined ? profileA : id));
    const { settings, stop } = create(true);
    await settle();
    expect(mocks.get.mock.calls[0]![1]).toBeUndefined();
    expect(settings.connectionProfileChoice.value).toBe(profileA);
    expect(settings.settingsForm.value.groupName).toBe('甲分组');
    stop();
    clearV2SessionDrafts();
    const refreshed = create(true);
    await settle();
    expect(refreshed.settings.connectionProfileChoice.value).toBe(profileA);
    expect(refreshed.settings.settingsForm.value.groupName).toBe('甲分组');
    refreshed.stop();
  });
  it('主动切换连接只读取对应配置，明确保存后才改变账号的首选连接', async () => {
    const { settings, stop } = create(true);
    await settle();
    settings.connectionProfileChoice.value = profileB;
    await settle();
    expect(mocks.get.mock.calls.at(-1)![1]).toBe(profileB);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(settings.connectorStatus.value).toBe('unknown');
    stop();
  });
  it('切换系统账号后旧保存响应不能改写新账号的连接和草稿', async () => {
    const first = create();
    await settle();
    first.settings.connectionProfileChoice.value = profileA;
    await settle();
    let finish!: (value: V2RechargeBitBrowserSettings) => void;
    mocks.save.mockImplementationOnce(() => new Promise((done) => (finish = done)));
    const saving = first.settings.saveSettings();
    sessionCoordinator.clearLocalSession({ reason: 'identity-switched', broadcast: false });
    mocks.get.mockResolvedValue(fixture(profileB));
    const second = create();
    await settle();
    second.settings.settingsForm.value.groupName = '第二个账号的输入';
    finish(fixture(profileA));
    await saving;
    expect(second.settings.connectionProfileChoice.value).toBe(profileB);
    expect(second.settings.settingsForm.value.groupName).toBe('第二个账号的输入');
    first.stop();
    second.stop();
  });
  it('子账号无分组或标签时仍可先检测并保存连接，但不能通过完整执行检查', async () => {
    const { settings, stop } = create(true);
    await settle();
    settings.connectionProfileChoice.value = 'new';
    Object.assign(settings.settingsForm.value, {
      connectionProfileName: 'Mac 子账号',
      localApiToken: 'synthetic-child-api-token'
    });
    mocks.catalog.mockResolvedValue({ groups: [], tags: [] });
    mocks.save.mockResolvedValue({
      ...fixture(profileB),
      groupName: '',
      tagName: '',
      dynamicProxyUrlConfigured: false
    });
    await settings.saveSettings();
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        directMode: true,
        groupName: '',
        tagName: '',
        newConnectionProfile: true
      })
    );
    expect(settings.connectorStatus.value).toBe('incomplete');
    await expect(settings.checkSavedConnection()).rejects.toThrow('分组和标签');
    expect(settings.connectorStatus.value).toBe('incomplete');
    stop();
  });
  it('保存失败保留输入，成功才清理当前提交快照并选中服务器生成的配置', async () => {
    const { settings, stop } = create();
    await settle();
    settings.connectionProfileChoice.value = 'new';
    Object.assign(settings.settingsForm.value, {
      connectionProfileName: '另一台电脑',
      localApiToken: 'synthetic-new-api-token',
      connectorToken: 'synthetic-new-helper-token'
    });
    mocks.save.mockRejectedValueOnce(new Error('模拟保存失败'));
    await settings.saveSettings();
    expect(settings.settingsForm.value.connectionProfileName).toBe('另一台电脑');
    expect(settings.connectionProfileChoice.value).toBe('new');
    mocks.save.mockResolvedValueOnce(fixture(profileB));
    await settings.saveSettings();
    expect(settings.connectionProfileChoice.value).toBe(profileB);
    expect(settings.settingsForm.value.localApiToken).toBe('');
    expect(settings.settingsForm.value.connectorToken).toBe('');
    stop();
  });
  it('迟到保存响应不清除后来输入，读取刷新不替换草稿原始版本', async () => {
    const { settings, stop } = create();
    await settle();
    settings.connectionProfileChoice.value = profileA;
    await settle();
    settings.settingsForm.value.groupName = '提交分组';
    let finish!: (value: V2RechargeBitBrowserSettings) => void;
    mocks.save.mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        })
    );
    const saving = settings.saveSettings();
    await Promise.resolve();
    settings.settingsForm.value.groupName = '后来编辑';
    finish({ ...fixture(profileA), updatedAt: '2026-10-12T01:00:00.000Z' });
    await saving;
    expect(settings.settingsForm.value.groupName).toBe('后来编辑');
    expect(mocks.save.mock.calls[0]![0].expectedUpdatedAt).toBe('2026-10-12T00:00:00.000Z');
    stop();
  });
  it('明确恢复已保存配置才能清除当前草稿，不影响其他配置草稿', async () => {
    const { settings, stop } = create();
    await settle();
    settings.connectionProfileChoice.value = profileA;
    await settle();
    settings.settingsForm.value.groupName = '待恢复输入';
    await settings.restoreSavedSettings();
    expect(settings.settingsForm.value.groupName).toBe('甲分组');
    stop();
  });
});
