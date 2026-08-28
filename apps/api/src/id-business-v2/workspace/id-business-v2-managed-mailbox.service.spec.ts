import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2ManagedMailboxService } from './id-business-v2-managed-mailbox.service';
import {
  MailProviderAuthenticationError,
  MailProviderUnavailableError
} from './providers/id-business-v2-imap-mail.provider';

const admin = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
const member = { ...admin, id: '33333333-3333-4333-8333-333333333333', roles: ['member'] };
const now = new Date('2026-08-15T16:00:00.000Z');
const queryCodeExpiresAt = new Date('2026-09-14T16:00:00.000Z');

function mailbox(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'member@gmail.com',
    label: '客户 A',
    provider: 'gmail' as const,
    providerCredentialEncrypted: 'encrypted',
    queryCodeHash: 'hashed-code',
    queryCodeHint: 'Ab23',
    queryCodeExpiresAt,
    status: 'active' as const,
    lastVerifiedAt: now,
    lastQueriedAt: null,
    lastErrorCode: null,
    createdByUserId: admin.id,
    updatedByUserId: admin.id,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe('IdBusinessV2ManagedMailboxService', () => {
  const tx = {};
  const repository = {
    list: vi.fn(),
    count: vi.fn(),
    findByEmail: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    updateStatus: vi.fn(),
    updateCredential: vi.fn(),
    updateQueryCode: vi.fn()
  };
  const transactionManager = {
    execute: vi.fn(async (work: (client: unknown, context: { businessTime: Date }) => unknown) =>
      work(tx, { businessTime: now })
    )
  };
  const audit = { append: vi.fn() };
  const encryption = {
    encrypt: vi.fn(() => 'encrypted'),
    hash: vi.fn(() => 'hashed-code')
  };
  const provider = { verify: vi.fn() };
  const service = new IdBusinessV2ManagedMailboxService(
    repository as never,
    transactionManager as never,
    audit as never,
    encryption as never,
    provider as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    repository.list.mockResolvedValue([mailbox()]);
    repository.count.mockResolvedValue(1);
    repository.findByEmail.mockResolvedValue(null);
    repository.findById.mockResolvedValue(mailbox());
    repository.create.mockImplementation(async (_tx, input) => mailbox(input));
    repository.updateStatus.mockImplementation(async (_tx, id, status, updatedByUserId) =>
      mailbox({ id, status, updatedByUserId })
    );
    repository.updateCredential.mockImplementation(async (_tx, id, input) =>
      mailbox({ id, status: 'active', updatedByUserId: input.updatedByUserId })
    );
    repository.updateQueryCode.mockImplementation(async (_tx, id, input) =>
      mailbox({ id, ...input })
    );
    provider.verify.mockResolvedValue(undefined);
    audit.append.mockResolvedValue({ id: 'audit-1' });
  });

  it('lists a filtered page without returning encrypted credentials or code hashes', async () => {
    const result = await service.list(
      { page: '2', pageSize: '10', provider: 'gmail', status: 'active', q: 'member' },
      admin
    );
    expect(repository.list).toHaveBeenCalledWith({
      skip: 10,
      take: 10,
      where: {
        provider: 'gmail',
        status: 'active',
        OR: [{ email: { contains: 'member' } }, { label: { contains: 'member' } }]
      }
    });
    expect(result).toMatchObject({ page: 2, pageSize: 10, total: 1 });
    expect(JSON.stringify(result)).not.toMatch(/encrypted|hashed-code/);
  });

  it('verifies provider authorization before storing encrypted credentials and returns a separate buyer code once', async () => {
    const result = await service.create(
      {
        email: ' Member@GMAIL.com ',
        provider: 'gmail',
        appPassword: 'abcd efgh ijkl mnop',
        label: ' 客户 A '
      },
      admin
    );
    expect(provider.verify).toHaveBeenCalledWith({
      email: 'member@gmail.com',
      provider: 'gmail',
      appPassword: 'abcdefghijklmnop'
    });
    expect(encryption.encrypt).toHaveBeenCalledWith('abcdefghijklmnop');
    expect(repository.create).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ queryCodeExpiresAt })
    );
    expect(result.mailbox.queryCodeExpiresAt).toBe(queryCodeExpiresAt.toISOString());
    expect(result.buyerCredential).toMatch(/^[A-Za-z2-9]{20}$/);
    expect(JSON.stringify(audit.append.mock.calls)).not.toMatch(
      /abcdefghijklmnop|----[A-Za-z2-9]{20}/
    );
  });

  it('rejects non-admin management and invalid iCloud domains', async () => {
    await expect(service.list({}, member)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.create(
        { email: 'member@gmail.com', provider: 'icloud', appPassword: 'app-password' },
        admin
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(provider.verify).not.toHaveBeenCalled();
  });

  it('returns actionable Gmail authorization guidance', async () => {
    provider.verify.mockRejectedValueOnce(new MailProviderAuthenticationError());
    await expect(
      service.create(
        {
          email: 'member@gmail.com',
          provider: 'gmail',
          appPassword: 'invalid-app-password'
        },
        admin,
        'request-auth-failed'
      )
    ).rejects.toMatchObject({
      response: {
        message: 'Gmail 授权失败，请确认已开启两步验证并使用 16 位应用专用密码'
      }
    });
  });

  it('reports provider saturation without storing mailbox credentials', async () => {
    provider.verify.mockRejectedValueOnce(new MailProviderUnavailableError('provider_busy'));
    await expect(
      service.create(
        {
          email: 'member@gmail.com',
          provider: 'gmail',
          appPassword: 'app-password'
        },
        admin,
        'request-provider-busy'
      )
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('does not reactivate an authorization-failed mailbox without a new app password', async () => {
    repository.findById.mockResolvedValueOnce(mailbox({ status: 'auth_failed' }));
    await expect(
      service.updateStatus(mailbox().id, { status: 'active' }, admin)
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });

  it('verifies a replacement app password and never audits it', async () => {
    await service.updateCredential(mailbox().id, { appPassword: 'new app password' }, admin);
    expect(provider.verify).toHaveBeenCalledWith({
      email: 'member@gmail.com',
      provider: 'gmail',
      appPassword: 'newapppassword'
    });
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('newapppassword');
  });

  it('rotates the buyer code with a fresh 30-day expiry and audits no plaintext code', async () => {
    const result = await service.rotateQueryCode(mailbox().id, admin);
    expect(repository.updateQueryCode).toHaveBeenCalledWith(
      tx,
      mailbox().id,
      expect.objectContaining({ queryCodeExpiresAt })
    );
    expect(result.mailbox.queryCodeExpiresAt).toBe(queryCodeExpiresAt.toISOString());
    expect(JSON.stringify(audit.append.mock.calls)).not.toMatch(/----[A-Za-z2-9]{20}/);
  });
});
