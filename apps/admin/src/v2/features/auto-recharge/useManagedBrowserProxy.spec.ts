import { effectScope, nextTick, ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';
import { useManagedBrowserProxy } from './useManagedBrowserProxy';
import type { BitBrowserSettingsForm } from './useRechargeBrowserSettings';
import type { RechargeProxyItem } from './recharge-proxy-api';
const mocks = vi.hoisted(() => ({ query: {} as Record<string, unknown> }));
vi.mock('@/v2/composables/useV2Query', () => ({ useV2ModuleQuery: () => mocks.query }));
const item = (
  id: string,
  connectionMode: 'extraction' | 'direct',
  protocol: 'http' | 'socks5',
  status: 'active' | 'disabled' = 'active'
): RechargeProxyItem => ({
  id,
  connectionMode,
  protocol,
  status,
  countryCode: 'US',
  kind: 'dynamic_residential',
  linkMask: 'fixture',
  remark1: null,
  remark2: null,
  createdAt: '',
  updatedAt: ''
});
beforeEach(() => {
  mocks.query = {
    data: ref({
      items: [
        item('dynamic', 'extraction', 'http'),
        item('fixed', 'direct', 'socks5'),
        item('disabled', 'extraction', 'http', 'disabled')
      ]
    }),
    phase: ref('ready')
  };
});
function fixture() {
  const form = ref({
    proxyId: '',
    proxyType: 'http',
    browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS }
  } as BitBrowserSettingsForm);
  const scope = effectScope();
  const catalog = scope.run(() => useManagedBrowserProxy(form, ref(true)))!;
  return { form, catalog, scope };
}
describe('窗口代理目录选择', () => {
  it('按模式过滤启用代理，切换模式清除不兼容选择，协议跟随目录', () => {
    const f = fixture();
    expect(f.catalog.matchingItems.value.map((row) => row.id)).toEqual(['dynamic']);
    f.form.value.proxyId = 'dynamic';
    expect(f.catalog.error.value).toBe('');
    f.form.value.browserOptions.proxyMode = 'static';
    expect(f.form.value.proxyId).toBe('');
    expect(f.catalog.matchingItems.value.map((row) => row.id)).toEqual(['fixed']);
    f.form.value.proxyId = 'fixed';
    expect(f.form.value.proxyType).toBe('socks5');
    expect(f.catalog.error.value).toBe('');
    f.scope.stop();
  });
  it('目录刷新后采用当前协议，停用或删除不能继续保存', async () => {
    const f = fixture();
    f.form.value.proxyId = 'dynamic';
    f.catalog.query.data.value = { items: [item('dynamic', 'extraction', 'socks5')] };
    await nextTick();
    expect(f.form.value.proxyType).toBe('socks5');
    f.catalog.query.data.value = { items: [item('dynamic', 'extraction', 'http', 'disabled')] };
    await nextTick();
    expect(f.catalog.error.value).toContain('已停用');
    f.catalog.query.data.value = { items: [] };
    await nextTick();
    expect(f.catalog.error.value).toContain('删除');
    f.scope.stop();
  });
  it('目录未读取或读取失败时阻止选择，读取恢复后允许保存', () => {
    const f = fixture();
    f.form.value.proxyId = 'dynamic';
    (mocks.query.phase as ReturnType<typeof ref<string>>).value = 'initial-error';
    expect(f.catalog.error.value).toContain('读取');
    (mocks.query.phase as ReturnType<typeof ref<string>>).value = 'ready';
    expect(f.catalog.error.value).toBe('');
    f.scope.stop();
  });
});
