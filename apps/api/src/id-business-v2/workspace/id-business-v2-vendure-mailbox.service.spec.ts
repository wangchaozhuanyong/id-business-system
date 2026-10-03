import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2VendureMailboxService } from './id-business-v2-vendure-mailbox.service';

const operator = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};

describe('IdBusinessV2VendureMailboxService', () => {
  it('任务绑定原邮箱地址，源邮箱变化后不读取新邮箱邮件', async () => {
    const client = { publicQuery: vi.fn().mockResolvedValue({ success: true, items: [] }) };
    const service = new IdBusinessV2VendureMailboxService(
      client as never,
      {} as never,
      {} as never
    );
    vi.spyOn(service, 'registrationMailbox').mockResolvedValue({
      email: 'changed@example.invalid',
      queryCode: 'synthetic-code'
    });
    await expect(
      service.registrationCode('alias-1', new Date(), null, operator, 'original@example.invalid')
    ).rejects.toThrow('邮箱地址已变化');
    expect(client.publicQuery).not.toHaveBeenCalled();
    await expect(
      service.registrationCode('alias-1', new Date(), null, operator, 'CHANGED@example.invalid')
    ).resolves.toBeNull();
    expect(client.publicQuery).toHaveBeenCalledTimes(1);
  });

  it('直接注册请求同样拒绝无效到期时间、已过期或缺少邮箱授权，不依赖候选筛选', async () => {
    const alias = {
      id: 'alias-1',
      aliasEmail: 'hidden@example.invalid',
      primaryAccountId: 'primary-1',
      status: 'ACTIVE',
      buyerQueryCode: 'synthetic-code',
      codeExpiresAt: null
    };
    const client = {
      virtualEmails: vi.fn().mockResolvedValue([alias]),
      primaryAccounts: vi.fn().mockResolvedValue([{ id: 'primary-1', status: 'ACTIVE' }])
    };
    const service = new IdBusinessV2VendureMailboxService(
      client as never,
      {} as never,
      {} as never
    );
    await expect(service.registrationMailbox('alias-1', operator)).resolves.toMatchObject({
      email: 'hidden@example.invalid'
    });
    for (const extra of [
      { codeExpiresAt: 'invalid' },
      { codeExpiresAt: '2000-01-01T00:00:00Z' },
      { buyerQueryCode: '' }
    ]) {
      client.virtualEmails.mockResolvedValueOnce([{ ...alias, ...extra }]);
      await expect(service.registrationMailbox('alias-1', operator)).rejects.toThrow('授权已失效');
    }
    expect(client.primaryAccounts).toHaveBeenCalledTimes(1);
  });

  it('注册摘要包含全部别名和准确可用性，不返回查询码或主邮箱授权资料', async () => {
    const base = {
      id: 'valid',
      aliasEmail: 'valid@example.invalid',
      primaryAccountId: 'primary-active',
      primaryAccountEmail: 'primary@example.invalid',
      status: 'ACTIVE',
      note: null,
      updatedAt: '2026-10-03T08:00:00Z',
      buyerQueryCode: 'synthetic-private-code',
      codeExpiresAt: null
    };
    const client = {
      virtualEmails: vi
        .fn()
        .mockResolvedValue([
          base,
          { ...base, id: 'disabled', status: 'DISABLED' },
          { ...base, id: 'expired', codeExpiresAt: '2000-01-01T00:00:00Z' },
          { ...base, id: 'invalid-expiry', codeExpiresAt: 'invalid' },
          { ...base, id: 'missing-code', buyerQueryCode: '' },
          { ...base, id: 'disabled-primary', primaryAccountId: 'primary-disabled' },
          { ...base, id: 'missing-primary', primaryAccountId: 'removed' }
        ]),
      primaryAccounts: vi.fn().mockResolvedValue([
        { id: 'primary-active', status: 'ACTIVE', masterQueryCode: 'synthetic-primary-code' },
        { id: 'primary-disabled', status: 'DISABLED' }
      ])
    };
    const service = new IdBusinessV2VendureMailboxService(
      client as never,
      {} as never,
      {} as never
    );
    const summaries = await service.registrationMailboxSummaries(operator);
    expect(summaries).toHaveLength(7);
    const byId = new Map(summaries.map((row) => [row.id, row]));
    expect(byId.get('valid')).toMatchObject({ authorizationValid: true, primaryAvailable: true });
    expect(byId.get('disabled')).toMatchObject({ status: 'DISABLED', authorizationValid: true });
    for (const id of ['expired', 'invalid-expiry', 'missing-code'])
      expect(byId.get(id)?.authorizationValid).toBe(false);
    for (const id of ['disabled-primary', 'missing-primary'])
      expect(byId.get(id)?.primaryAvailable).toBe(false);
    expect(JSON.stringify(summaries)).not.toContain('synthetic-private-code');
    expect(JSON.stringify(summaries)).not.toContain('synthetic-primary-code');
    expect(JSON.stringify(summaries)).not.toContain('buyerQueryCode');
    expect(JSON.stringify(summaries)).not.toContain('masterQueryCode');
    const readCount = client.virtualEmails.mock.calls.length;
    await expect(
      service.registrationMailboxSummaries({ ...operator, roles: ['staff'] })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(client.virtualEmails).toHaveBeenCalledTimes(readCount);
  });

  it('人工标记只读取真实别名地址，不要求查询码仍有效；无权限或邮箱移除时拒绝', async () => {
    const client = {
      virtualEmails: vi.fn().mockResolvedValue([
        {
          id: 'alias-1',
          aliasEmail: 'HIDDEN@example.invalid',
          updatedAt: '2026-10-02T12:00:00Z',
          status: 'DISABLED',
          buyerQueryCode: '',
          codeExpiresAt: '2000-01-01T00:00:00Z'
        }
      ])
    };
    const service = new IdBusinessV2VendureMailboxService(
      client as never,
      {} as never,
      {} as never
    );
    await expect(service.aliasAddress('alias-1', operator)).resolves.toEqual({
      email: 'hidden@example.invalid',
      updatedAt: '2026-10-02T12:00:00Z'
    });
    await expect(service.aliasAddress('removed', operator)).rejects.toThrow('隐藏邮箱不存在');
    const reads = client.virtualEmails.mock.calls.length;
    await expect(
      service.aliasAddress('alias-1', { ...operator, roles: ['staff'] })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(client.virtualEmails).toHaveBeenCalledTimes(reads);
  });
  it('账号复制只读取现有有效查询码，缺失、重复、停用或过期时拒绝', async () => {
    const alias = {
      id: 'alias-1',
      aliasEmail: 'hidden@example.invalid',
      status: 'ACTIVE',
      buyerQueryCode: 'BUY-TEST',
      codeExpiresAt: null
    };
    const client = { virtualEmails: vi.fn().mockResolvedValue([alias]) };
    const service = new IdBusinessV2VendureMailboxService(
      client as never,
      {} as never,
      {} as never
    );
    await expect(service.accountBuyerCode('HIDDEN@example.invalid', operator)).resolves.toEqual({
      aliasId: 'alias-1',
      buyerQueryCode: 'BUY-TEST'
    });
    for (const records of [
      [],
      [alias, alias],
      [{ ...alias, status: 'DISABLED' }],
      [{ ...alias, buyerQueryCode: '' }],
      [{ ...alias, codeExpiresAt: '2000-01-01T00:00:00Z' }],
      [{ ...alias, codeExpiresAt: 'invalid' }]
    ]) {
      client.virtualEmails.mockResolvedValueOnce(records);
      await expect(service.accountBuyerCode('hidden@example.invalid', operator)).rejects.toThrow();
    }
    await expect(
      service.accountBuyerCode('hidden@example.invalid', { ...operator, roles: ['staff'] })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('distinguishes configuration from a verified Vendure connection', async () => {
    const disconnected = new IdBusinessV2VendureMailboxService(
      {
        isConfigured: vi.fn(() => true),
        checkConnection: vi.fn().mockRejectedValue(new Error('授权无效或权限不足'))
      } as never,
      {} as never,
      {} as never
    );
    await expect(disconnected.status(operator)).resolves.toEqual({
      configured: true,
      connected: false,
      message: '授权无效或权限不足'
    });

    const connected = new IdBusinessV2VendureMailboxService(
      {
        isConfigured: vi.fn(() => true),
        checkConnection: vi.fn().mockResolvedValue(true)
      } as never,
      {} as never,
      {} as never
    );
    await expect(connected.status(operator)).resolves.toEqual({
      configured: true,
      connected: true,
      message: null
    });
  });

  it('filters and paginates the shared Vendure records for administrators', async () => {
    const client = {
      primaryAccounts: vi.fn().mockResolvedValue([
        {
          id: '1',
          email: 'disabled@example.com',
          note: '',
          status: 'DISABLED',
          updatedAt: '2026-09-13T00:00:00.000Z'
        },
        {
          id: '2',
          email: 'buyer@example.com',
          note: '销售邮箱',
          status: 'ACTIVE',
          updatedAt: '2026-09-14T00:00:00.000Z'
        }
      ])
    };
    const service = new IdBusinessV2VendureMailboxService(
      client as never,
      {} as never,
      {} as never
    );

    await expect(service.listPrimary({}, undefined)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.listPrimary({ q: 'BUYER', status: 'ACTIVE' }, operator)
    ).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: '2', email: 'buyer@example.com' })]
    });
  });

  it('enforces the requested virtual mailbox boundary when the upstream list is broader', async () => {
    const client = {
      receivedMails: vi.fn().mockResolvedValue([
        {
          id: 'mail-for-alias',
          primaryAccountId: 'primary-1',
          virtualEmailId: 'alias-1',
          subject: '目标邮件',
          receivedAt: '2026-09-14T03:00:00.000Z'
        },
        {
          id: 'mail-for-other-alias',
          primaryAccountId: 'primary-1',
          virtualEmailId: 'alias-2',
          subject: '其他虚拟邮箱邮件',
          receivedAt: '2026-09-14T04:00:00.000Z'
        },
        {
          id: 'mail-for-other-primary',
          primaryAccountId: 'primary-2',
          virtualEmailId: 'alias-1',
          subject: '其他主邮箱邮件',
          receivedAt: '2026-09-14T05:00:00.000Z'
        }
      ])
    };
    const service = new IdBusinessV2VendureMailboxService(
      client as never,
      {} as never,
      {} as never
    );

    await expect(
      service.listMails(
        { primaryAccountId: 'primary-1', virtualEmailId: 'alias-1', page: 1, pageSize: 20 },
        operator
      )
    ).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: 'mail-for-alias' })]
    });
    expect(client.receivedMails).toHaveBeenCalledWith(
      expect.objectContaining({ primaryAccountId: 'primary-1', virtualEmailId: 'alias-1' })
    );
  });

  it('searches and paginates older messages beyond the first 500', async () => {
    const mails = Array.from({ length: 650 }, (_, index) => ({
      id: `mail-${index}`,
      subject: index === 649 ? 'older target' : 'recent',
      receivedAt: '2026-09-14T05:00:00.000Z'
    }));
    const client = {
      receivedMails: vi.fn(async ({ limit }: { limit: number }) => mails.slice(0, limit))
    };
    const service = new IdBusinessV2VendureMailboxService(
      client as never,
      {} as never,
      {} as never
    );
    const found = await service.listMails({ q: 'older target', page: 1, pageSize: 20 }, operator);
    expect(found.total).toBe(1);
    expect(found.items[0]?.id).toBe('mail-649');
    expect(client.receivedMails).toHaveBeenCalledTimes(2);
    const page = await service.listMails({ page: 33, pageSize: 20 }, operator);
    expect(page.total).toBe(650);
    expect(page.items).toHaveLength(10);
  });

  it('writes a sanitized local audit entry after a remote mutation succeeds', async () => {
    const created = {
      id: 'primary-1',
      email: 'owner@example.com',
      status: 'ACTIVE'
    };
    const client = { createPrimary: vi.fn().mockResolvedValue(created) };
    const audit = { append: vi.fn().mockResolvedValue(undefined) };
    const transactionManager = {
      execute: vi.fn(async (work: (tx: object) => Promise<void>) => work({}))
    };
    const service = new IdBusinessV2VendureMailboxService(
      client as never,
      transactionManager as never,
      audit as never
    );

    await service.createPrimary(
      { email: 'OWNER@EXAMPLE.COM', appPassword: 'private-app-password', note: '主邮箱' },
      operator,
      'request-1'
    );

    expect(client.createPrimary).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'owner@example.com', appPassword: 'private-app-password' })
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'id_business_v2.vendure_mailbox.primary.create',
        objectId: 'primary-1'
      })
    );
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('private-app-password');
  });

  it('warns against retrying when the remote write succeeded but local audit failed', async () => {
    const client = {
      createPrimary: vi.fn().mockResolvedValue({ id: 'primary-1', email: 'owner@example.com' })
    };
    const transactionManager = {
      execute: vi.fn().mockRejectedValue(new Error('database unavailable'))
    };
    const service = new IdBusinessV2VendureMailboxService(
      client as never,
      transactionManager as never,
      {} as never
    );

    const error = await service
      .createPrimary({ email: 'owner@example.com', appPassword: 'private-app-password' }, operator)
      .catch((value) => value);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toContain('操作已完成');
    expect(error.message).toContain('不要重复提交');
  });
});
