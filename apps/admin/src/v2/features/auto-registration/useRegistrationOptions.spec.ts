import { effectScope, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import { useRegistrationOptions } from './useRegistrationOptions';
import type { RegistrationOptions } from './api';
const mock = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  ensureFresh: vi.fn(),
  read: vi.fn()
}));
vi.mock('@/v2/composables/useV2Query', () => ({
  createV2QueryKey: JSON.stringify,
  useV2ModuleQuery: (config: Record<string, unknown>) => {
    mock.config = config;
    return { data: ref<RegistrationOptions>(), ensureFresh: mock.ensureFresh };
  }
}));
vi.mock('./api', () => ({ registrationApi: { options: mock.read } }));
let scope: ReturnType<typeof effectScope>;
let state: ReturnType<typeof useRegistrationOptions>;
beforeEach(() => {
  clearV2SessionDrafts();
  vi.clearAllMocks();
  scope = effectScope();
  state = scope.run(() => useRegistrationOptions(() => true))!;
});
afterEach(() => {
  scope.stop();
  clearV2SessionDrafts();
});
describe('注册资料独立搜索和候选分页', () => {
  it('代理搜索重置代理页码，姓名搜索与页码保持不变；反向搜索也相互独立', async () => {
    state.optionFilters.proxyPage = 2;
    state.optionFilters.namePage = 3;
    state.optionFilters.nameSearch = '李';
    state.searchProxyOptions(' 美国 ');
    expect(state.optionFilters).toEqual({
      proxySearch: '美国',
      proxyPage: 1,
      nameSearch: '李',
      namePage: 3
    });
    state.optionFilters.proxyPage = 2;
    state.searchNameOptions(' 王 ');
    expect(state.optionFilters).toEqual({
      proxySearch: '美国',
      proxyPage: 2,
      nameSearch: '王',
      namePage: 1
    });
    await nextTick();
    expect(mock.ensureFresh).toHaveBeenCalled();
  });
  it('下拉翻页后已选代理与姓名继续显示已读取的文字，不显示内部编号', async () => {
    const data: RegistrationOptions = {
      mailboxes: [],
      defaultProxyId: null,
      mailboxTotal: 0,
      proxies: [{ id: 'proxy-1', label: '美国代理', countryCode: 'US' }],
      names: [{ id: 'name-1', displayName: '李华' }],
      proxyTotal: 103,
      nameTotal: 203
    };
    state.options.data.value = data as RegistrationOptions;
    await nextTick();
    state.options.data.value = { ...data, proxies: [], names: [] } as RegistrationOptions;
    await nextTick();
    expect(state.proxyChoices('proxy-1')[0]?.label).toBe('美国代理');
    expect(state.nameChoices('name-1')[0]?.displayName).toBe('李华');
    expect(state.proxyPageCount.value).toBe(2);
    expect(state.namePageCount.value).toBe(3);
  });
  it('未读回的旧草稿标识使用中文提示，避免直接展示内部资料编号', () => {
    expect(state.proxyChoices('opaque-id')[0]?.label).toContain('请核对');
    expect(state.nameChoices('opaque-id')[0]?.displayName).toContain('请核对');
  });
});
