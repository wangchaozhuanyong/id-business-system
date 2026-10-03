import { describe, expect, it, vi } from 'vitest';
import { RegistrationMailboxesService } from './registration-mailboxes.service';

const operator = { id: 'operator-1', roles: ['admin'] } as never;
const version = '2026-10-03T08:00:00.000Z';
function mailbox(id: string, extra: object = {}) {
  return {
    id,
    email: `${id}@example.invalid`,
    primaryEmail: 'primary@example.invalid',
    status: 'ACTIVE',
    note: null,
    updatedAt: version,
    authorizationValid: true,
    primaryAvailable: true,
    ...extra
  };
}
function fixture() {
  const repository = {
    accountsByEmailHashes: vi.fn().mockResolvedValue([]),
    unfinishedJobsByEmailHashes: vi.fn().mockResolvedValue([])
  };
  const mailboxes = { registrationMailboxSummaries: vi.fn().mockResolvedValue([]) };
  const service = new RegistrationMailboxesService(
    repository as never,
    mailboxes as never,
    {} as never,
    {} as never,
    { hash: (value: string) => `hash:${value}` } as never
  );
  return { repository, mailboxes, service };
}

describe('注册邮箱完整分类和启动条件', () => {
  it('先分类再分页，所有邮箱不遗漏，停用邮箱保留且相同时间按编号稳定排序', async () => {
    const { service, repository, mailboxes } = fixture();
    const rows = Array.from({ length: 25 }, (_, index) =>
      mailbox(`alias-${String(index).padStart(2, '0')}`, {
        status: index % 3 === 0 ? 'DISABLED' : 'ACTIVE'
      })
    );
    mailboxes.registrationMailboxSummaries.mockResolvedValue([...rows].reverse());
    const accounts = rows.map((row, index) => ({
      id: `account-${index}`,
      emailHash: `hash:${row.email}`,
      registered: index % 2 === 1,
      updatedAt: new Date(version)
    }));
    repository.accountsByEmailHashes.mockResolvedValue(accounts);
    const all = await service.list({ page: '2', pageSize: '5' }, operator);
    expect(all.total).toBe(25);
    expect(all.items.map((row) => row.id)).toEqual([
      'alias-05',
      'alias-06',
      'alias-07',
      'alias-08',
      'alias-09'
    ]);
    const unregistered = await service.list(
      { registrationStatus: 'unregistered', page: '2', pageSize: '5' },
      operator
    );
    expect(unregistered.total).toBe(13);
    expect(unregistered.items.map((row) => row.id)).toEqual([
      'alias-10',
      'alias-12',
      'alias-14',
      'alias-16',
      'alias-18'
    ]);
    expect(unregistered.items[1]).toMatchObject({
      status: 'DISABLED',
      registered: false,
      accountId: 'account-12'
    });
    const registered = await service.list(
      { registrationStatus: 'registered', page: '3', pageSize: '5' },
      operator
    );
    expect(registered.total).toBe(12);
    expect(registered.items.map((row) => row.id)).toEqual(['alias-21', 'alias-23']);
    accounts[0]!.registered = true;
    const changed = await service.list({ registrationStatus: 'unregistered' }, operator);
    expect(changed.total).toBe(12);
    expect(changed.items.some((row) => row.id === 'alias-00')).toBe(false);
    const last = await service.list(
      { registrationStatus: 'unregistered', page: '4', pageSize: '5' },
      operator
    );
    expect(last).toMatchObject({ items: [], total: 12, page: 4, pageSize: 5 });
  });

  it('搜索完整邮箱、主邮箱和备注后再分类统计，时间不同按最近更新排序', async () => {
    const { service, repository, mailboxes } = fixture();
    mailboxes.registrationMailboxSummaries.mockResolvedValue([
      mailbox('older', {
        primaryEmail: 'SEARCH@example.invalid',
        updatedAt: '2026-10-02T08:00:00Z'
      }),
      mailbox('registered', { note: 'search note' }),
      mailbox('search-newer'),
      mailbox('unrelated')
    ]);
    repository.accountsByEmailHashes.mockResolvedValue([
      {
        emailHash: 'hash:registered@example.invalid',
        id: 'account',
        registered: true,
        updatedAt: new Date(version)
      }
    ]);
    const result = await service.list(
      { keyword: ' SEARCH ', registrationStatus: 'unregistered', pageSize: '1' },
      operator
    );
    expect(result).toMatchObject({ total: 2, items: [{ id: 'search-newer' }] });
    const last = await service.list(
      { keyword: 'search', registrationStatus: 'unregistered', page: '2', pageSize: '1' },
      operator
    );
    expect(last.items.map((row) => row.id)).toEqual(['older']);
  });

  it('只允许可用未注册邮箱启动；未结束任务优先提示且不会泄露其他管理员任务编号', async () => {
    const { service, repository, mailboxes } = fixture();
    mailboxes.registrationMailboxSummaries.mockResolvedValue([
      mailbox('registered'),
      mailbox('disabled', { status: 'DISABLED' }),
      mailbox('expired', { authorizationValid: false }),
      mailbox('primary', { primaryAvailable: false }),
      mailbox('pending-owned'),
      mailbox('pending-other'),
      mailbox('available')
    ]);
    repository.accountsByEmailHashes.mockResolvedValue([
      {
        emailHash: 'hash:registered@example.invalid',
        registered: true,
        id: 'account-1',
        updatedAt: new Date(version)
      },
      {
        emailHash: 'hash:pending-owned@example.invalid',
        registered: true,
        id: 'account-2',
        updatedAt: new Date(version)
      }
    ]);
    repository.unfinishedJobsByEmailHashes.mockResolvedValue([
      { emailHash: 'hash:pending-owned@example.invalid', id: 'owned-job', ownerId: 'operator-1' },
      {
        emailHash: 'hash:pending-other@example.invalid',
        id: 'private-other-job',
        ownerId: 'operator-2'
      }
    ]);
    const result = await service.list({}, operator);
    const byId = new Map(result.items.map((row) => [row.id, row]));
    for (const [id, reason] of [
      ['registered', 'registered'],
      ['disabled', 'mailbox_disabled'],
      ['expired', 'authorization_invalid'],
      ['primary', 'primary_unavailable'],
      ['pending-owned', 'unfinished_task'],
      ['pending-other', 'unfinished_task']
    ])
      expect(byId.get(id!)).toMatchObject({ canStart: false, startBlockedReason: reason });
    expect(byId.get('pending-owned')?.pendingJobId).toBe('owned-job');
    expect(byId.get('pending-other')?.pendingJobId).toBeNull();
    expect(byId.get('available')).toMatchObject({
      canStart: true,
      startBlockedReason: null,
      pendingJobId: null
    });
    expect(JSON.stringify(result)).not.toContain('private-other-job');
    expect(JSON.stringify(result)).not.toContain('authorizationValid');
    expect(JSON.stringify(result)).not.toContain('primaryAvailable');
  });

  it('非法状态在读取前拒绝，空数据不读取账号或任务；读取失败不会伪装为可启动', async () => {
    const { service, repository, mailboxes } = fixture();
    await expect(service.list({ registrationStatus: 'unknown' }, operator)).rejects.toThrow(
      '筛选无效'
    );
    await expect(service.list({ keyword: 'a'.repeat(121) }, operator)).rejects.toThrow('搜索内容');
    await expect(service.list({ keyword: [] as never }, operator)).rejects.toThrow('搜索内容');
    expect(mailboxes.registrationMailboxSummaries).not.toHaveBeenCalled();
    await expect(service.list({}, operator)).resolves.toMatchObject({ items: [], total: 0 });
    expect(repository.accountsByEmailHashes).not.toHaveBeenCalled();
    expect(repository.unfinishedJobsByEmailHashes).not.toHaveBeenCalled();
    mailboxes.registrationMailboxSummaries.mockResolvedValue([mailbox('available')]);
    repository.unfinishedJobsByEmailHashes.mockRejectedValueOnce(new Error('任务查询失败'));
    await expect(service.list({}, operator)).rejects.toThrow('任务查询失败');
  });
});
