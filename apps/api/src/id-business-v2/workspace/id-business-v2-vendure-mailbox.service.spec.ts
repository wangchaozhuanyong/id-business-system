import { ForbiddenException } from '@nestjs/common';
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
});
