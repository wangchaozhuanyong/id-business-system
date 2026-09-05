import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2MicrosoftMailboxAuthorizationService } from './id-business-v2-microsoft-mailbox-authorization.service';
import { MailProviderAuthenticationError } from './providers/id-business-v2-imap-mail.provider';

const admin = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
const authorizationId = '44444444-4444-4444-8444-444444444444';
const now = new Date('2026-08-28T18:00:00.000Z');

function authorization(overrides: Record<string, unknown> = {}) {
  return {
    id: authorizationId,
    stateHash: 'hashed-state',
    email: 'member@outlook.com',
    label: '客户 M',
    status: 'pending' as const,
    failureCode: null,
    mailboxId: null,
    createdByUserId: admin.id,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function mailbox(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'member@outlook.com',
    label: '客户 M',
    provider: 'microsoft' as const,
    providerCredentialEncrypted: 'encrypted-refresh-token',
    queryCodeHash: 'hashed-query-code',
    queryCodeEncrypted: 'encrypted-query-code',
    queryCodeHint: 'Ab23',
    queryCodeExpiresAt: new Date('2026-09-27T18:00:00.000Z'),
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

describe('IdBusinessV2MicrosoftMailboxAuthorizationService', () => {
  const tx = {};
  const repository = {
    findByEmail: vi.fn(),
    findById: vi.fn(),
    updateCredential: vi.fn(),
    create: vi.fn()
  };
  const transactionManager = {
    execute: vi.fn(async (work: (client: unknown, context: { businessTime: Date }) => unknown) =>
      work(tx, { businessTime: now })
    )
  };
  const audit = { append: vi.fn() };
  const encryption = {
    encrypt: vi.fn((value: string) => `encrypted:${value}`),
    hash: vi.fn((value: string) => `hashed:${value}`)
  };
  const transientState = {
    createAuthorization: vi.fn(),
    findAuthorizationById: vi.fn(),
    claimPendingAuthorization: vi.fn(),
    failAuthorization: vi.fn(),
    succeedAuthorization: vi.fn()
  };
  const provider = { verify: vi.fn() };
  const microsoftOAuth = {
    createAuthorizationUrl: vi.fn(),
    exchangeAuthorizationCode: vi.fn()
  };
  const settings = {
    getValidityDays: vi.fn(async () => 30),
    expiresAt: vi.fn(
      (issuedAt: Date, validityDays: number) =>
        new Date(issuedAt.getTime() + validityDays * 24 * 60 * 60 * 1000)
    )
  };
  const service = new IdBusinessV2MicrosoftMailboxAuthorizationService(
    repository as never,
    transactionManager as never,
    audit as never,
    encryption as never,
    transientState as never,
    provider as never,
    microsoftOAuth as never,
    settings as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    repository.findByEmail.mockResolvedValue(null);
    transientState.createAuthorization.mockImplementation((input) => authorization(input));
    transientState.findAuthorizationById.mockReturnValue(authorization());
    transientState.claimPendingAuthorization.mockReturnValue(
      authorization({ status: 'processing', processingStartedAt: new Date() })
    );
    transientState.failAuthorization.mockReturnValue(true);
    transientState.succeedAuthorization.mockReturnValue(true);
    repository.create.mockImplementation(async (_tx, input) => mailbox(input));
    audit.append.mockResolvedValue({ id: 'audit-1' });
    provider.verify.mockResolvedValue(undefined);
    microsoftOAuth.createAuthorizationUrl.mockReturnValue('https://login.microsoftonline.com/auth');
    microsoftOAuth.exchangeAuthorizationCode.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token'
    });
    settings.getValidityDays.mockResolvedValue(30);
  });

  it('starts a bounded authorization without storing mailbox passwords or OAuth tokens', async () => {
    const result = await service.start({ email: ' Member@Outlook.com ', label: ' 客户 M ' }, admin);
    expect(microsoftOAuth.createAuthorizationUrl).toHaveBeenCalledWith(
      expect.any(String),
      'member@outlook.com'
    );
    expect(transientState.createAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'member@outlook.com',
        label: '客户 M',
        createdByUserId: admin.id
      })
    );
    expect(result.authorizationUrl).toBe('https://login.microsoftonline.com/auth');
    expect(JSON.stringify(transientState.createAuthorization.mock.calls)).not.toMatch(
      /password|token/i
    );
  });

  it('exchanges OAuth2, verifies Outlook IMAP and stores only encrypted credentials', async () => {
    await expect(
      service.complete({ code: 'microsoft-authorization-code', state: 'valid-oauth-state-value' })
    ).resolves.toEqual({ succeeded: true });
    expect(provider.verify).toHaveBeenCalledWith({
      accessToken: 'access-token',
      email: 'member@outlook.com',
      provider: 'microsoft'
    });
    expect(repository.create).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        provider: 'microsoft',
        providerCredentialEncrypted: 'encrypted:refresh-token',
        queryCodeEncrypted: expect.stringMatching(/^encrypted:/)
      })
    );
    expect(settings.expiresAt).toHaveBeenCalledWith(now, 30);
    expect(JSON.stringify(repository.create.mock.calls)).not.toContain('access-token');
    expect(audit.append).toHaveBeenCalled();
    expect(transientState.succeedAuthorization).toHaveBeenCalledWith(authorizationId, mailbox().id);
  });

  it.each([undefined, '', 'short'])(
    'rejects malformed state %s before exchanging tokens',
    async (state) => {
      await expect(
        service.complete({ code: 'microsoft-authorization-code', state })
      ).rejects.toThrow('Microsoft 授权状态无效');
      expect(microsoftOAuth.exchangeAuthorizationCode).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    }
  );

  it('distinguishes rejected IMAP access from OAuth consent without persisting credentials', async () => {
    provider.verify.mockRejectedValueOnce(new MailProviderAuthenticationError());

    await expect(
      service.complete({ code: 'microsoft-authorization-code', state: 'valid-oauth-state-value' })
    ).resolves.toEqual({ succeeded: false, failureCode: 'mailbox_auth_failed' });

    expect(microsoftOAuth.exchangeAuthorizationCode).toHaveBeenCalled();
    expect(transientState.failAuthorization).toHaveBeenCalledWith(
      authorizationId,
      'mailbox_auth_failed'
    );
    expect(encryption.encrypt).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('returns only a controlled failure code when an unexpected completion error occurs', async () => {
    settings.getValidityDays.mockRejectedValueOnce(new Error('private-provider-error-detail'));

    await expect(
      service.complete({ code: 'microsoft-authorization-code', state: 'valid-oauth-state-value' })
    ).resolves.toEqual({ succeeded: false, failureCode: 'completion_failed' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rejects unknown, expired or consumed state before exchanging tokens', async () => {
    transientState.claimPendingAuthorization.mockReturnValueOnce(null);

    await expect(
      service.complete({ code: 'microsoft-authorization-code', state: 'invalid-oauth-state-value' })
    ).rejects.toThrow('Microsoft 授权任务无效或已完成');
    expect(microsoftOAuth.exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
  });
});
