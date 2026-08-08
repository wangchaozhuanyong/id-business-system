import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2AccountsController } from './id-business-v2-accounts.controller';

const operator = {
  id: '20000000-0000-4000-8000-000000000001',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};

describe('IdBusinessV2AccountsController request metadata', () => {
  const accountsService = {
    create: vi.fn(),
    update: vi.fn(),
    changeRecordStatus: vi.fn(),
    revealSecret: vi.fn(),
    exportRows: vi.fn(),
    importRows: vi.fn()
  };
  const controller = new IdBusinessV2AccountsController(accountsService as never, {} as never);

  it('passes the infrastructure request ID into write commands', () => {
    const request = { requestId: 'request-account-create', headers: {} };
    const dto = {
      appleId: 'user@example.com',
      countryOptionId: 'country-1',
      statusOptionId: 'status-1'
    };

    controller.create(dto, operator, request);
    controller.changeRecordStatus(
      'account-1',
      { recordStatus: 'disabled', reason: '暂不使用' },
      operator,
      request
    );

    expect(accountsService.create).toHaveBeenCalledWith(dto, operator, {
      requestId: request.requestId
    });
    expect(accountsService.changeRecordStatus).toHaveBeenCalledWith(
      'account-1',
      { recordStatus: 'disabled', reason: '暂不使用' },
      operator,
      { requestId: request.requestId }
    );
  });

  it('passes request ID and non-secret request metadata into sensitive access', () => {
    const request = {
      requestId: 'request-account-reveal',
      ip: '127.0.0.1',
      headers: { 'user-agent': 'vitest' }
    };
    const dto = { field: 'password' as const, reason: '执行续费' };

    controller.revealSecret('account-1', dto, operator, request);

    expect(accountsService.revealSecret).toHaveBeenCalledWith('account-1', dto, operator, {
      requestId: request.requestId,
      ip: request.ip,
      userAgent: 'vitest'
    });
  });
});
