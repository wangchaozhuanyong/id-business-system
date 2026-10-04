import { effectScope, ref, nextTick } from 'vue';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import { useRegistrationMailboxes } from './useRegistrationMailboxes';
import type { V2RegistrationMailbox, V2RegistrationMailboxStatusFilter } from './contracts';

const mock = vi.hoisted(() => ({
  mark: vi.fn(),
  country: vi.fn(),
  refresh: vi.fn(),
  ensureFresh: vi.fn()
}));
vi.mock('@/api/client', () => ({ getApiErrorMessage: (error: Error) => error.message }));
vi.mock('@/v2/composables/useV2Query', () => ({
  createV2QueryKey: JSON.stringify,
  useV2ModuleQuery: () => ({
    data: ref({ items: [] }),
    refresh: mock.refresh,
    ensureFresh: mock.ensureFresh
  })
}));
vi.mock('@/v2/features/auto-recharge/public-api', () => ({
  chatgptCountries: [
    ['MY', '马来西亚'],
    ['US', '美国'],
    ['JP', '日本']
  ]
}));
vi.mock('./api', () => ({
  registrationApi: { markRegistered: mock.mark, updateCountry: mock.country }
}));
const row: V2RegistrationMailbox = {
  id: 'alias-1',
  email: 'hidden@example.invalid',
  primaryEmail: 'primary@example.invalid',
  status: 'ACTIVE',
  registered: false,
  accountId: null,
  accountUpdatedAt: null,
  note: null,
  updatedAt: '',
  canStart: true,
  startBlockedReason: null,
  pendingJobId: null
};
let scope: ReturnType<typeof effectScope>;
let page: ReturnType<typeof useRegistrationMailboxes>;
beforeEach(() => {
  vi.clearAllMocks();
  clearV2SessionDrafts();
  mock.country.mockResolvedValue({ id: 'account-1' });
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
  it('不同分类保存各自分页，切回每页数量不同的分类仍恢复原页码', async () => {
    scope.stop();
    const status = ref<V2RegistrationMailboxStatusFilter>('all');
    scope = effectScope();
    page = scope.run(() =>
      useRegistrationMailboxes(
        () => true,
        () => status.value
      )
    )!;
    page.changePage(2);
    status.value = 'unregistered';
    await nextTick();
    page.changePageSize(50);
    page.changePage(3);
    status.value = 'all';
    await nextTick();
    expect(page.filters.page).toBe(2);
    expect(page.filters.pageSize).toBe(20);
    status.value = 'unregistered';
    await nextTick();
    expect(page.filters.page).toBe(3);
    expect(page.filters.pageSize).toBe(50);
  });
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
  it('已注册行可改回未注册，携带账号版本并保留已有资料', async () => {
    const registered = {
      ...row,
      registered: true,
      accountId: 'account-1',
      accountUpdatedAt: '2026-10-03T08:00:00Z'
    };
    page.openMark(registered);
    expect(page.confirmOpen.value).toBe(true);
    expect(mock.mark).not.toHaveBeenCalled();
    await page.confirm();
    expect(mock.mark).toHaveBeenCalledWith(
      row.id,
      row.updatedAt,
      false,
      registered.accountUpdatedAt
    );
    expect(page.message.value).toBe('已标记未注册，已有账号资料保留');
  });
  it('改回已注册复用原账号，未保存前取消仍保留目标', async () => {
    page.openMark(row);
    page.setConfirmOpen(false);
    expect(page.target.value?.id).toBe(row.id);
    page.openMark(row);
    mock.mark.mockResolvedValueOnce({ accountId: 'account-1', created: false });
    await page.confirm();
    expect(mock.mark).toHaveBeenCalledWith(row.id, row.updatedAt, true, null);
    expect(page.message.value).toBe('已标记已注册，已复用现有 ChatGPT 账号');
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
    page.setConfirmOpen(false);
    expect(page.confirmOpen.value).toBe(true);
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
  it('下拉选择原状态不会保存，新状态取消后保留原行且无请求', () => {
    page.openMark(row, false);
    expect(page.confirmOpen.value).toBe(false);
    page.openMark(row, true);
    page.setConfirmOpen(false);
    expect(mock.mark).not.toHaveBeenCalled();
    expect(row.registered).toBe(false);
  });
  it('选择邮箱仅登记选择，不直接建立任务；不可注册邮箱不能替换选择', () => {
    page.select(row);
    expect(page.selected.value?.id).toBe(row.id);
    page.select({ ...row, id: 'registered', canStart: false, registered: true });
    expect(page.selected.value?.id).toBe(row.id);
    expect(mock.mark).not.toHaveBeenCalled();
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

const countryRow = {
  ...row,
  registered: true,
  accountId: 'account-1',
  registrationCountryCode: 'MY',
  accountUpdatedAt: '2026-10-04T08:00:00.000Z'
};
describe('隐藏邮箱注册国家修改', () => {
  it('国家回填，保存只提交国家与原账号版本', async () => {
    page.openCountry(countryRow);
    expect(page.countryDraft.form.registrationCountryCode).toBe('MY');
    page.countryDraft.form.registrationCountryCode = 'US';
    await page.saveCountry();
    expect(mock.country).toHaveBeenCalledWith('account-1', 'US', countryRow.accountUpdatedAt);
    expect(page.countryOpen.value).toBe(false);
    expect(page.message.value).toBe('国家已修改');
    page.openCountry({ ...countryRow, registrationCountryCode: 'US' });
    expect(page.countryDraft.form.registrationCountryCode).toBe('US');
  });
  it('失败保留输入并可重试，未知国家可清空', async () => {
    page.openCountry(countryRow);
    page.countryDraft.form.registrationCountryCode = '';
    mock.country.mockRejectedValueOnce(new Error('账号资料已变化'));
    await page.saveCountry();
    expect(page.countryOpen.value).toBe(true);
    expect(page.countryError.value).toBe('账号资料已变化');
    expect(page.countryDraft.form.registrationCountryCode).toBe('');
    await page.saveCountry();
    expect(mock.country).toHaveBeenLastCalledWith('account-1', null, countryRow.accountUpdatedAt);
  });
  it('按账号保留草稿，关闭、换记录及离页返回保留原版本', () => {
    page.openCountry(countryRow);
    page.countryDraft.form.registrationCountryCode = 'US';
    page.setCountryOpen(false);
    page.openCountry({
      ...countryRow,
      id: 'alias-2',
      accountId: 'account-2',
      registrationCountryCode: 'JP'
    });
    expect(page.countryDraft.form.registrationCountryCode).toBe('JP');
    scope.stop();
    scope = effectScope();
    page = scope.run(() => useRegistrationMailboxes(() => true))!;
    page.openCountry({ ...countryRow, accountUpdatedAt: '2026-10-04T09:00:00.000Z' });
    expect(page.countryDraft.form.registrationCountryCode).toBe('US');
    expect(page.countryDraft.version.value).toBe(countryRow.accountUpdatedAt);
  });
  it('非法国家和未注册记录不写入', async () => {
    page.openCountry(row);
    expect(page.countryOpen.value).toBe(false);
    page.openCountry(countryRow);
    page.countryDraft.form.registrationCountryCode = 'invalid';
    await page.saveCountry();
    expect(page.countryError.value).toBe('请选择有效的国家');
    expect(mock.country).not.toHaveBeenCalled();
  });
  it('提交中不重复发送、不允许关闭或换记录，迟到响应不改变新页面', async () => {
    let finish!: () => void;
    mock.country.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    page.openCountry(countryRow);
    page.countryDraft.form.registrationCountryCode = 'US';
    const save = page.saveCountry();
    page.setCountryOpen(false);
    page.openCountry({ ...countryRow, accountId: 'account-2' });
    await page.saveCountry();
    expect(page.countryOpen.value).toBe(true);
    expect(page.countryTarget.value?.accountId).toBe('account-1');
    expect(mock.country).toHaveBeenCalledOnce();
    scope.stop();
    finish();
    await save;
    expect(mock.refresh).not.toHaveBeenCalled();
    expect(page.message.value).toBe('');
  });
  it('写入成功但刷新失败仍明确告知已保存', async () => {
    page.openCountry(countryRow);
    mock.refresh.mockRejectedValueOnce(new Error('读取失败'));
    await page.saveCountry();
    expect(page.countryOpen.value).toBe(false);
    expect(page.countryError.value).toBe('');
    expect(page.message.value).toContain('国家已修改；列表刷新失败');
  });
});
