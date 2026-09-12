import { effectScope, ref } from 'vue';
import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readBrowserCatalog, useRechargeBrowserCatalog } from './useRechargeBrowserCatalog';
import type { BitBrowserSettingsForm } from './useRechargeBrowserSettings';
import type { V2RechargeBrowserCatalog } from './contracts';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  catalog: vi.fn(),
  health: vi.fn(),
  query: {} as Record<string, unknown>
}));
vi.mock('./api', () => ({
  rechargeApi: { browserCatalogAccess: mocks.access },
  rechargeConnectorApi: { browserCatalog: mocks.catalog, health: mocks.health }
}));
vi.mock('@/v2/composables/useV2Query', () => ({ useV2ModuleQuery: () => mocks.query }));
const form = (): BitBrowserSettingsForm => ({
  connectorUrl: 'http://127.0.0.1:55321',
  localApiUrl: 'http://127.0.0.1:54345',
  connectorToken: '',
  localApiToken: '',
  dynamicProxyUrl: '',
  proxyType: 'http',
  groupName: '分组甲',
  tagName: '标签乙',
  browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS },
  staticProxyUsername: '',
  staticProxyPassword: '',
  clearStaticProxyCredentials: false
});
const catalog: V2RechargeBrowserCatalog = {
  groups: [{ id: 'group-a', name: '分组甲' }],
  tags: [{ id: 'tag-b', name: '标签乙' }]
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockImplementation(async () => ({
    ...form(),
    connectorToken: 'c'.repeat(32),
    localApiToken: 'b'.repeat(32)
  }));
  mocks.catalog.mockResolvedValue(catalog);
  mocks.health.mockResolvedValue({ ok: true });
  mocks.query = {
    data: ref(catalog),
    phase: ref('ready'),
    refresh: vi.fn().mockResolvedValue(catalog)
  };
});
describe('比特浏览器真实分组和标签选择', () => {
  it('列表已打开时刷新会重新读取，关闭销毁后不再发请求', async () => {
    const scope = effectScope();
    const choices = scope.run(() =>
      useRechargeBrowserCatalog(ref(form()), ref(true), ref(undefined))
    )!;
    await choices.refreshCatalog();
    await choices.refreshCatalog();
    expect(mocks.query.refresh).toHaveBeenCalledTimes(2);
    scope.stop();
    await choices.refreshCatalog();
    expect(mocks.query.refresh).toHaveBeenCalledTimes(2);
  });
  it('复用已保存连接凭据读取列表，请求结束清除临时秘密', async () => {
    const signal = new AbortController().signal;
    let observed;
    mocks.catalog.mockImplementationOnce(async (access) => {
      observed = { ...access };
      return catalog;
    });
    expect(await readBrowserCatalog(form(), signal)).toEqual(catalog);
    expect(observed).toMatchObject({
      localApiToken: 'b'.repeat(32),
      connectorToken: 'c'.repeat(32)
    });
    expect(mocks.catalog.mock.calls[0][0].localApiToken).toBe('');
    expect(mocks.catalog.mock.calls[0][0].connectorToken).toBe('');
  });
  it('首次设置可直接用新填写密钥读取，不依赖保存分组', async () => {
    await readBrowserCatalog(
      { ...form(), localApiToken: 'b'.repeat(32), connectorToken: 'c'.repeat(32) },
      new AbortController().signal
    );
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.catalog).toHaveBeenCalledOnce();
  });
  it('更换连接地址后不向新地址发送旧密钥', async () => {
    await expect(
      readBrowserCatalog(
        { ...form(), localApiUrl: 'http://127.0.0.1:55555' },
        new AbortController().signal
      )
    ).rejects.toThrow('连接地址已更换');
    expect(mocks.catalog).not.toHaveBeenCalled();
  });
  it('只允许有效唯一选项；连接变更后旧列表立即失效', () => {
    const scope = effectScope();
    const draft = ref(form());
    const choices = scope.run(() => useRechargeBrowserCatalog(draft, ref(false), ref(undefined)))!;
    choices.refreshCatalog();
    expect(choices.selectionError.value).toBe('');
    (mocks.query.data as ReturnType<typeof ref>).value = {
      ...catalog,
      tags: [catalog.tags[0], { id: 'tag-c', name: '标签乙' }]
    };
    expect(choices.tagOptions.value.every((item) => item.disabled)).toBe(true);
    expect(choices.selectionError.value).toContain('标签');
    draft.value.localApiUrl = 'http://127.0.0.1:55555';
    expect(choices.catalogReady.value).toBe(false);
    expect(choices.tagOptions.value).toEqual([]);
    scope.stop();
  });
});
