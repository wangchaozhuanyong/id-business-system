import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { AppleMailboxManualSync } from './apple-mailbox-manual-sync';
import type { AuthenticatedUser } from '../../auth/auth.types';

const actor = { id: 'fixture-actor', roles: ['admin'] } as AuthenticatedUser;
const alias = { id: 'alias-one', email: 'manual@example.test' };
const input = { items: [{ aliasId: alias.id, revision: 4 }] };
const record = () => ({
  email: alias.email,
  aliasId: alias.id,
  revision: 4,
  registrationStatus: 'registered',
  source: 'manual',
  activeTaskUuid: null,
  registrationIp: null,
  manualSyncId: 'stable-operation'
});

describe('人工已注册资料补齐', () => {
  const worker = { appleMailboxRequest: vi.fn() };
  const mailboxes = { registrationMailboxSummaries: vi.fn() };
  const accounts = { previewManualRegistered: vi.fn(), mirrorManualRegistered: vi.fn() };
  const audit = { create: vi.fn() };
  let service: AppleMailboxManualSync;
  beforeEach(() => {
    vi.resetAllMocks();
    service = new AppleMailboxManualSync(
      worker as never,
      mailboxes as never,
      accounts as never,
      audit as never
    );
    mailboxes.registrationMailboxSummaries.mockResolvedValue([alias]);
    accounts.previewManualRegistered.mockResolvedValue({ status: 'create', accountId: null });
    accounts.mirrorManualRegistered.mockResolvedValue({ accountId: 'main-id', replayed: false });
    worker.appleMailboxRequest.mockImplementation(async (path: string) =>
      path.endsWith('/records') ? { records: [record()] } : { record: record() }
    );
  });

  it('预览只读取已确认人工记录，不创建任务或主账号', async () => {
    expect(await service.preview(input, actor)).toMatchObject({
      total: 1,
      creatable: 1,
      items: [{ status: 'create', accountId: null }]
    });
    expect(accounts.mirrorManualRegistered).not.toHaveBeenCalled();
    expect(
      worker.appleMailboxRequest.mock.calls.every((call) => call[0].endsWith('/records'))
    ).toBe(true);
  });
  it.each([
    { revision: 3 },
    { activeTaskUuid: 'active' },
    { registrationStatus: 'unregistered' },
    { source: 'automatic' },
    { creationConfirmed: true },
    { aliasId: 'changed' }
  ])('状态或版本变化 %j 不进行补建', async (change) => {
    worker.appleMailboxRequest.mockResolvedValue({ records: [{ ...record(), ...change }] });
    expect(await service.sync(input, actor)).toMatchObject({ synchronized: 0, skipped: 1 });
    expect(accounts.mirrorManualRegistered).not.toHaveBeenCalled();
  });
  it('补齐保留未知IP为空，只在准备回执来源核对后创建并确认', async () => {
    expect(await service.sync(input, actor)).toMatchObject({ synchronized: 1, failed: 0 });
    expect(accounts.mirrorManualRegistered).toHaveBeenCalledWith(
      { email: alias.email, aliasId: alias.id, revision: 4, registrationIp: null },
      actor
    );
    expect(worker.appleMailboxRequest).toHaveBeenLastCalledWith(
      '/internal/apple-mailboxes/manual-sync-ack',
      'POST',
      expect.objectContaining({
        manualSyncId: 'stable-operation',
        status: 'saved',
        accountId: 'main-id'
      })
    );
    expect(JSON.stringify(audit.create.mock.calls)).not.toContain(alias.email);
  });
  it('已存在或丢失回执可安全重放，准备及确认不伪造注册任务', async () => {
    let failAck = true;
    worker.appleMailboxRequest.mockImplementation(async (path: string) => {
      if (path.endsWith('/records')) return { records: [record()] };
      if (path.endsWith('/manual-sync-ack') && failAck) {
        failAck = false;
        throw new Error('lost receipt');
      }
      return { record: record() };
    });
    expect(await service.sync(input, actor)).toMatchObject({ failed: 1 });
    expect(await service.sync(input, actor)).toMatchObject({ synchronized: 1 });
    expect(accounts.mirrorManualRegistered).toHaveBeenCalledTimes(2);
    expect(
      worker.appleMailboxRequest.mock.calls.every(
        (call) => !/\/tasks|\/start|\/batch/.test(call[0])
      )
    ).toBe(true);
  });
  it('已有账号冲突或存储失败以受控错误确认，不泄漏秘密', async () => {
    accounts.mirrorManualRegistered.mockRejectedValue(
      new ConflictException('synthetic-private-value')
    );
    expect(await service.sync(input, actor)).toMatchObject({
      failed: 1,
      items: [{ status: 'conflict' }]
    });
    expect(worker.appleMailboxRequest).toHaveBeenLastCalledWith(
      '/internal/apple-mailboxes/manual-sync-ack',
      'POST',
      expect.objectContaining({ status: 'conflict', errorKind: 'email_conflict' })
    );
    expect(JSON.stringify(worker.appleMailboxRequest.mock.calls)).not.toContain(
      'synthetic-private-value'
    );
  });
  it('拒绝操作者、邮箱及版本伪造', async () => {
    await expect(service.sync(input, { ...actor, roles: ['employee'] })).rejects.toThrow('管理员');
    await expect(service.sync({ ...input, operatorId: 'other' }, actor)).rejects.toThrow('参数');
    await expect(
      service.sync({ items: [{ aliasId: alias.id, revision: '4' }] }, actor)
    ).rejects.toThrow('参数');
    await expect(
      service.sync({ items: [{ aliasId: alias.id, revision: 4, email: 'forged' }] }, actor)
    ).rejects.toThrow('参数');
    expect(accounts.mirrorManualRegistered).not.toHaveBeenCalled();
  });
});
