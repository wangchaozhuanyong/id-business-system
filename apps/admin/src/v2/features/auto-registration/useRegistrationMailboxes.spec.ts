import { effectScope, ref } from 'vue';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import { useRegistrationMailboxes } from './useRegistrationMailboxes';
import type { V2RegistrationMailbox } from './contracts';

const mock = vi.hoisted(() => ({ mark: vi.fn(), refresh: vi.fn(), ensureFresh: vi.fn() }));
vi.mock('@/api/client', () => ({ getApiErrorMessage: (error: Error) => error.message }));
vi.mock('@/v2/composables/useV2Query', () => ({
  createV2QueryKey: JSON.stringify,
  useV2ModuleQuery: () => ({
    data: ref({ items: [] }),
    refresh: mock.refresh,
    ensureFresh: mock.ensureFresh
  })
}));
vi.mock('./api', () => ({ registrationApi: { markRegistered: mock.mark } }));
const row: V2RegistrationMailbox = {
  id: 'alias-1',
  email: 'hidden@example.invalid',
  primaryEmail: 'primary@example.invalid',
  status: 'ACTIVE',
  registered: false,
  accountId: null,
  note: null,
  updatedAt: ''
};
let scope: ReturnType<typeof effectScope>;
let page: ReturnType<typeof useRegistrationMailboxes>;
beforeEach(() => {
  vi.clearAllMocks();
  clearV2SessionDrafts();
  mock.mark.mockResolvedValue({ accountId: 'account-1', created: true });
  mock.refresh.mockResolvedValue(undefined);
  scope = effectScope();
  page = scope.run(() => useRegistrationMailboxes(() => true))!;
});
afterEach(() => {
  scope.stop();
  clearV2SessionDrafts();
});
describe('隐藏邮箱人工注册标记', () => {
  it('明确确认后才提交，失败保留当前目标并允许重试', async () => {
    page.openMark(row);
    expect(mock.mark).not.toHaveBeenCalled();
    mock.mark.mockRejectedValueOnce(new Error('保存失败'));
    await page.confirm();
    expect(page.confirmOpen.value).toBe(true);
    expect(page.target.value?.id).toBe(row.id);
    expect(page.error.value).toBe('保存失败');
    await page.confirm();
    expect(page.confirmOpen.value).toBe(false);
    expect(page.message.value).toContain('已加入 ChatGPT 账号');
    expect(mock.refresh).toHaveBeenCalledOnce();
  });
  it('已注册行不能重复打开标记，重复请求返回复用现有账号', async () => {
    page.openMark({ ...row, registered: true });
    expect(page.confirmOpen.value).toBe(false);
    page.openMark(row);
    mock.mark.mockResolvedValueOnce({ accountId: 'account-1', created: false });
    await page.confirm();
    expect(page.message.value).toBe('已复用现有 ChatGPT 账号');
  });
  it('提交中不能重发或切换目标，离页后的迟到响应不关闭新页面', async () => {
    let finish!: (value: { accountId: string; created: boolean }) => void;
    mock.mark.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    page.openMark(row);
    const save = page.confirm();
    page.openMark({ ...row, id: 'other-alias' });
    await page.confirm();
    expect(page.target.value?.id).toBe(row.id);
    expect(mock.mark).toHaveBeenCalledOnce();
    scope.stop();
    finish({ accountId: 'account-1', created: true });
    await save;
    expect(page.confirmOpen.value).toBe(true);
    expect(page.message.value).toBe('');
    expect(mock.refresh).not.toHaveBeenCalled();
  });
  it('保存成功但刷新失败时仍告知已保存，不伪装成账号写入失败', async () => {
    page.openMark(row);
    mock.refresh.mockRejectedValueOnce(new Error('读取失败'));
    await page.confirm();
    expect(page.confirmOpen.value).toBe(false);
    expect(page.error.value).toBe('');
    expect(page.message.value).toContain('已加入 ChatGPT 账号；列表刷新失败');
  });
  it('筛选输入、分页和标记目标复用会话草稿', () => {
    page.filters.keyword = 'hidden';
    page.search();
    page.filters.page = 3;
    page.openMark(row);
    scope.stop();
    scope = effectScope();
    page = scope.run(() => useRegistrationMailboxes(() => true))!;
    expect(page.filters.appliedKeyword).toBe('hidden');
    expect(page.filters.page).toBe(3);
    expect(page.target.value?.id).toBe(row.id);
  });
});
