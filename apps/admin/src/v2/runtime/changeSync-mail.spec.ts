import { V2_DATA_SCOPES } from '@apple-business/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ versions: vi.fn(), stream: vi.fn(), invalidate: vi.fn() }));
vi.mock('@/v2/api/changeSync', () => ({
  idBusinessV2ChangeSyncApi: { getVersions: mocks.versions, streamEvents: mocks.stream }
}));
vi.mock('@/api/client', () => ({ isRequestCanceled: () => false }));
vi.mock('@/auth/sessionCoordinator', () => ({
  sessionCoordinator: { subscribeIdentityChange: () => () => undefined }
}));
vi.mock('@/v2/composables/useV2Query', () => ({ invalidateV2Queries: mocks.invalidate }));
vi.mock('@/v2/services/feedback', () => ({ showV2Warning: vi.fn() }));
let runtime: typeof import('./changeSync');
let handlers: { onEvent: (type: string, value: unknown) => void };
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  runtime = await import('./changeSync');
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('navigator', { onLine: true });
  mocks.invalidate.mockReset();
  mocks.versions.mockReset().mockResolvedValue({
    generatedAt: new Date().toISOString(),
    versions: Object.fromEntries(V2_DATA_SCOPES.map((scope) => [scope, '0']))
  });
  mocks.stream.mockReset().mockImplementation((options) => {
    handlers = options;
    return new Promise(() => undefined);
  });
});
afterEach(() => {
  runtime.stopV2ChangeSync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('邮箱只由事件及连接恢复更新', () => {
  it('新邮件事件更新一次，重复或旧版本不重复刷新', async () => {
    const listener = vi.fn();
    const unsubscribe = runtime.subscribeV2ScopeChanges(listener);
    runtime.startV2ChangeSync();
    await vi.advanceTimersByTimeAsync(0);
    const payload = {
      schemaVersion: 1,
      eventId: 'fixture',
      occurredAt: new Date().toISOString(),
      scopes: [{ scope: 'vendure-mailbox', version: '1' }]
    };
    handlers.onEvent('change', payload);
    handlers.onEvent('change', payload);
    expect(listener).toHaveBeenCalledExactlyOnceWith(['vendure-mailbox']);
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
  it('固定间隔退化检查不刷新邮箱，回到前台补齐缺失事件', async () => {
    const listener = vi.fn();
    const unsubscribe = runtime.subscribeV2ScopeChanges(listener);
    runtime.startV2ChangeSync();
    await vi.advanceTimersByTimeAsync(0);
    mocks.versions.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      versions: Object.fromEntries(
        V2_DATA_SCOPES.map((scope) => [scope, scope === 'vendure-mailbox' ? '1' : '0'])
      )
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listener).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5001);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledExactlyOnceWith(['vendure-mailbox']);
    unsubscribe();
  });
});
