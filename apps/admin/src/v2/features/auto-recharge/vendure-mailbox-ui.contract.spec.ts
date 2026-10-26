import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const view = readFileSync(new URL('./VendureMailboxManager.vue', import.meta.url), 'utf8');
const routeView = readFileSync(new URL('./V2VendureMailboxView.vue', import.meta.url), 'utf8');
const api = readFileSync(new URL('./vendure-mailbox-api.ts', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./vendure-mailbox.css', import.meta.url), 'utf8');
const tableSchemas = readFileSync(new URL('../tableSchemas.ts', import.meta.url), 'utf8');

describe('Vendure mailbox UI contract', () => {
  it('keeps the same three management areas and the shared V2 interaction primitives', () => {
    expect(routeView).toContain('<VendureMailboxManager');
    expect(view).toContain('主邮箱管理');
    expect(view).toContain('虚拟邮箱管理');
    expect(view).toContain('收件记录');
    expect(view.match(/<V2TableActionColumn/g)).toHaveLength(3);
    expect(view).toContain('<V2AsyncRegion');
    expect(view).toContain('<V2FormDrawer');
    expect(view).toContain('<V2ConfirmDialog');
    expect(view).toContain('label-position="left"');
    expect(view).toContain('require-asterisk-position="right"');
    expect(view).not.toContain('v-loading');
    expect(view).not.toContain('<el-skeleton');
    expect(view).toContain('isPrimaryActionRunning');
    expect(view).toContain('连接正常');
    expect(view).toContain('已有操作正在处理中');
    expect(view).toContain('一键复制');
    expect(view).toContain('操作已完成，但列表刷新失败');
    expect(view).toContain('互通服务连接异常');
    expect(view.match(/class="v2-records-mobile-list"/g)).toHaveLength(3);
    expect(styles).toContain('.vendure-mailbox-toolbar__filters');
    expect(tableSchemas.match(/mobileMode: 'cards'/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('selects a virtual mailbox before opening mail results and exposes the active scope', () => {
    const selectAlias = view.indexOf('virtualEmailId.value = row.id;');
    const openMails = view.indexOf("activeTab.value = 'mails';", selectAlias);

    expect(selectAlias).toBeGreaterThan(-1);
    expect(openMails).toBeGreaterThan(selectAlias);
    expect(view).toContain('当前收件范围');
    expect(view).toContain('仅显示 ${selectedAliasEmail} 的邮件');
    expect(view).toContain('void activeQuery.value.ensureFresh();');
    expect(view).toContain("if (tab === 'mails') void aliasQuery.ensureFresh();");
    expect(view).not.toContain('void nextTick');
  });

  it('connects every displayed management area to the ID server proxy', () => {
    expect(api).toContain("const base = '/id-business-v2/vendure-mailboxes'");
    expect(api).toContain('`${base}/primary-accounts`');
    expect(api).toContain('`${base}/aliases`');
    expect(api).toContain('`${base}/mails`');
    expect(api).not.toContain('VENDURE_MAILBOX_API_KEY');
    expect(api).not.toContain('vendure-api-key');
  });

  it('normalizes the list and both latest-code paths and guards OTP copying independently from query-code copying', () => {
    expect(view.match(/\.map\(normalizeV2MailboxVerificationMail\)/g)).toHaveLength(3);
    expect(view).toContain('verificationCode && !isV2MailboxVerificationCode(value)');
    expect(view).toContain('copyCodeWithFeedback(row.extractedCode, true)');
    expect(view).toContain('copyCodeWithFeedback(relayResult.latestOtp.code, true)');
    expect(view).toContain('copyCodeWithFeedback(mail.extractedCode, true)');
    expect(view).toContain('copyCodeWithFeedback(value, true)');
    expect(view).toContain('copyCodeWithFeedback(row.masterQueryCode)');
    expect(view).toContain('copyCodeWithFeedback(row.buyerQueryCode)');
    expect(view).toContain('验证码未识别');
  });
});

// Exercise the production query cache while the independent remote sync is slow.
import { effectScope } from 'vue';
import { afterEach, vi } from 'vitest';
import { clearV2QueryCache, invalidateV2Queries, useV2Query } from '@/v2/composables/useV2Query';
import { createVendureMailboxRefresh } from './vendure-mailbox-refresh';

function deferredSync() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => clearV2QueryCache());

describe('mailbox list and synchronization event regression', () => {
  it('renders saved records while repeated real scope invalidations cannot restart remote sync', async () => {
    const scope = effectScope();
    let version = 1;
    const query = scope.run(() =>
      useV2Query({
        scope: 'vendure-mailbox',
        key: 'mail-sync-regression',
        query: async () => version
      })
    )!;
    const remote = deferredSync();
    const sync = vi.fn(() => remote.promise);
    const pending = vi.fn();
    const refresh = createVendureMailboxRefresh<{ key: string }>({
      sync,
      read: () => query.refresh(),
      pending,
      error: vi.fn()
    });
    try {
      await query.ensureFresh();
      const running = refresh.refresh({ key: 'primary-a' });
      await Promise.resolve();
      for (let event = 0; event < 5; event++) {
        invalidateV2Queries('vendure-mailbox');
        await query.ensureFresh();
        expect(query.data.value).toBe(1);
        expect(query.isInitialLoading.value).toBe(false);
      }
      expect(sync).toHaveBeenCalledTimes(1);
      expect(pending).toHaveBeenLastCalledWith(true);
      version = 2;
      remote.resolve();
      await running;
      expect(query.data.value).toBe(2);
      expect(pending).toHaveBeenLastCalledWith(false);
    } finally {
      refresh.dispose();
      scope.stop();
    }
  });

  it('coalesces repeated requests for the same owner during a slow synchronization', async () => {
    const remote = deferredSync();
    const sync = vi.fn(() => remote.promise);
    const read = vi.fn(async () => undefined);
    const refresh = createVendureMailboxRefresh<{ key: string }>({
      sync,
      read,
      pending: vi.fn(),
      error: vi.fn()
    });
    const running = refresh.refresh({ key: 'a' });
    for (let click = 0; click < 5; click++) expect(refresh.refresh({ key: 'a' })).toBe(running);
    await Promise.resolve();
    expect(sync).toHaveBeenCalledTimes(1);
    remote.resolve();
    await running;
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('serializes owner changes and processes only the latest queued selection', async () => {
    const first = deferredSync();
    const last = deferredSync();
    const sync = vi.fn((item: { key: string }) =>
      item.key === 'a' ? first.promise : last.promise
    );
    const pending = vi.fn();
    const refresh = createVendureMailboxRefresh({
      sync,
      read: vi.fn(async () => undefined),
      pending,
      error: vi.fn()
    });
    const running = refresh.refresh({ key: 'a' });
    refresh.refresh({ key: 'b' });
    refresh.refresh({ key: 'c' });
    await Promise.resolve();
    expect(sync.mock.calls.map(([item]) => item.key)).toEqual(['a']);
    first.resolve();
    await running;
    await vi.waitFor(() => expect(sync.mock.calls.map(([item]) => item.key)).toEqual(['a', 'c']));
    last.resolve();
    await vi.waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
  });

  it('reports synchronization failure without hiding saved rows and permits an explicit retry', async () => {
    const error = new Error('synthetic-sync-failure');
    const sync = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    const report = vi.fn();
    const read = vi.fn(async () => undefined);
    const pending = vi.fn();
    const refresh = createVendureMailboxRefresh<{ key: string }>({
      sync,
      read,
      pending,
      error: report
    });
    await refresh.refresh({ key: 'a' });
    expect(report).toHaveBeenCalledWith(error, { key: 'a' });
    expect(read).not.toHaveBeenCalled();
    expect(pending).toHaveBeenLastCalledWith(false);
    await refresh.refresh({ key: 'a' });
    expect(sync).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not refresh a disposed page or start a queued operation after navigation', async () => {
    const remote = deferredSync();
    const sync = vi.fn(() => remote.promise);
    const read = vi.fn(async () => undefined);
    const refresh = createVendureMailboxRefresh<{ key: string }>({
      sync,
      read,
      pending: vi.fn(),
      error: vi.fn()
    });
    const running = refresh.refresh({ key: 'a' });
    refresh.refresh({ key: 'b' });
    await Promise.resolve();
    refresh.dispose();
    remote.resolve();
    await running;
    expect(sync).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    await refresh.refresh({ key: 'c' });
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('keeps event-driven reads passive and renders cached data before independent synchronization', () => {
    const queryBlock = view.slice(
      view.indexOf('const mailQuery ='),
      view.indexOf('const activeQuery =')
    );
    expect(queryBlock).toContain('refresh: false');
    expect(queryBlock).not.toContain('refresh: true');
    expect(queryBlock).not.toContain('syncBeforeMailRead');
    expect(view).toContain('sync: (scope) => vendureMailboxApi.mails(scope.query)');
    expect(view).toContain('const result = await query.refresh();');
    expect(view).toContain('void mailRefresh.refresh(scope);');
    expect(view).toContain('正在同步邮箱，已有收件记录仍可查看。');
    expect(view).toContain('mailRefresh.dispose();');
  });
});
