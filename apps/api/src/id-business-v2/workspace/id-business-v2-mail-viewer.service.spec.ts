import { BadRequestException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2MailViewerService } from './id-business-v2-mail-viewer.service';
import {
  MailProviderAuthenticationError,
  MailProviderUnavailableError
} from './providers/id-business-v2-imap-mail.provider';

const now = new Date('2026-08-15T16:00:00.000Z');

function mailbox(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'member@gmail.com',
    label: null,
    provider: 'gmail' as const,
    providerCredentialEncrypted: 'encrypted-app-password',
    queryCodeHash: 'hash:buyer-code',
    queryCodeEncrypted: 'encrypted-query-code',
    queryCodeHint: 'code',
    queryCodeExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    status: 'active' as const,
    lastVerifiedAt: now,
    lastQueriedAt: null,
    lastErrorCode: null,
    createdByUserId: '11111111-1111-4111-8111-111111111111',
    updatedByUserId: '11111111-1111-4111-8111-111111111111',
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe('IdBusinessV2MailViewerService', () => {
  const repository = {
    findByQueryCodeHash: vi.fn(),
    updateQueryState: vi.fn(),
    updateProviderCredential: vi.fn()
  };
  const transientState = { reservePublicQuery: vi.fn() };
  const encryption = {
    decrypt: vi.fn(),
    encrypt: vi.fn(() => 'encrypted-refresh-token'),
    hash: vi.fn((value: string | null | undefined) => (value ? `hash:${value}` : null))
  };
  const provider = { query: vi.fn() };
  const microsoftOAuth = { refreshAccessToken: vi.fn() };
  const service = new IdBusinessV2MailViewerService(
    repository as never,
    transientState as never,
    encryption as never,
    provider as never,
    microsoftOAuth as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    transientState.reservePublicQuery.mockReturnValue(true);
    repository.findByQueryCodeHash.mockResolvedValue(mailbox());
    repository.updateQueryState.mockResolvedValue(mailbox());
    encryption.decrypt.mockReturnValue('provider-app-password');
    provider.query.mockResolvedValue([
      {
        body: '验证码：123456',
        from: 'sender@example.com',
        savedAt: now.toISOString(),
        subject: '登录验证码',
        to: 'member@gmail.com'
      }
    ]);
  });

  it('verifies the buyer code locally and reads the managed mailbox without exposing secrets', async () => {
    const result = await service.query({ queryCode: 'buyer-code', limit: 5 }, '203.0.113.20');

    expect(provider.query).toHaveBeenCalledWith(
      {
        appPassword: 'provider-app-password',
        email: 'member@gmail.com',
        provider: 'gmail'
      },
      5
    );
    expect(result).toMatchObject({ email: 'member@gmail.com', provider: 'gmail' });
    expect(JSON.stringify(result)).not.toContain('buyer-code');
    expect(JSON.stringify(result)).not.toContain('provider-app-password');
    expect(repository.findByQueryCodeHash).toHaveBeenCalledWith('hash:buyer-code');
    expect(transientState.reservePublicQuery).toHaveBeenCalledWith(
      expect.objectContaining({ queryCodeHash: 'hash:buyer-code' })
    );
    expect(repository.updateQueryState).toHaveBeenCalledWith(
      mailbox().id,
      expect.objectContaining({ status: 'active' })
    );
  });

  it('refreshes Microsoft OAuth2 and queries Outlook without a mailbox password', async () => {
    repository.findByQueryCodeHash.mockResolvedValueOnce(
      mailbox({ email: 'member@outlook.com', provider: 'microsoft' })
    );
    encryption.decrypt.mockReturnValueOnce('stored-refresh-token');
    microsoftOAuth.refreshAccessToken.mockResolvedValueOnce({
      accessToken: 'current-access-token',
      refreshToken: 'rotated-refresh-token'
    });

    await service.query({ queryCode: 'buyer-code', limit: 5 }, '203.0.113.20');

    expect(provider.query).toHaveBeenCalledWith(
      {
        accessToken: 'current-access-token',
        email: 'member@outlook.com',
        provider: 'microsoft'
      },
      5
    );
    expect(encryption.encrypt).toHaveBeenCalledWith('rotated-refresh-token');
    expect(repository.updateProviderCredential).toHaveBeenCalledWith(
      mailbox().id,
      'encrypted-refresh-token'
    );
  });

  it('returns the same generic failure for an unknown, disabled, expired or invalid mailbox', async () => {
    repository.findByQueryCodeHash.mockResolvedValueOnce(null);
    await expect(
      service.query({ queryCode: 'missing-code', limit: 5 }, '203.0.113.20')
    ).rejects.toThrow('邮件查询码不正确');

    repository.findByQueryCodeHash.mockResolvedValueOnce(mailbox({ status: 'disabled' }));
    await expect(
      service.query({ queryCode: 'buyer-code', limit: 5 }, '203.0.113.20')
    ).rejects.toThrow('邮件查询码不正确');

    repository.findByQueryCodeHash.mockResolvedValueOnce(
      mailbox({ queryCodeExpiresAt: new Date(Date.now() - 1) })
    );
    await expect(
      service.query({ queryCode: 'buyer-code', limit: 5 }, '203.0.113.20')
    ).rejects.toThrow('邮件查询码不正确');

    repository.findByQueryCodeHash.mockResolvedValueOnce(mailbox());
    await expect(
      service.query({ queryCode: 'wrong-code', limit: 5 }, '203.0.113.20')
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(provider.query).not.toHaveBeenCalled();
  });

  it('rate limits by query code or IP before reading provider credentials', async () => {
    transientState.reservePublicQuery.mockReturnValueOnce(false);
    const error = await service
      .query({ queryCode: 'buyer-code', limit: 5 }, '203.0.113.20')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect(repository.findByQueryCodeHash).not.toHaveBeenCalled();
  });

  it('marks revoked provider authorization without leaking the provider password', async () => {
    provider.query.mockRejectedValueOnce(new MailProviderAuthenticationError());
    const error = await service
      .query({ queryCode: 'buyer-code', limit: 5 }, '203.0.113.20')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(String((error as Error).message)).not.toContain('provider-app-password');
    expect(repository.updateQueryState).toHaveBeenCalledWith(mailbox().id, {
      lastErrorCode: 'provider_auth_failed',
      status: 'auth_failed'
    });
  });

  it('reports an unconfigured Edge mail runtime clearly', async () => {
    provider.query.mockRejectedValueOnce(new MailProviderUnavailableError('edge_runtime'));
    await expect(
      service.query({ queryCode: 'buyer-code', limit: 5 }, '203.0.113.20')
    ).rejects.toThrow('邮件查询服务尚未配置，请联系卖家');
  });

  it('accepts legacy combined credentials while returning only the query-code lookup', async () => {
    await service.query({ credential: 'Member@GMAIL.COM----buyer-code', limit: 5 }, '203.0.113.20');
    expect(repository.findByQueryCodeHash).toHaveBeenCalledWith('hash:buyer-code');
  });

  it('validates the query code and result limit before database access', async () => {
    await expect(service.query({ queryCode: '', limit: 5 })).rejects.toThrow('请输入邮件查询码');
    await expect(service.query({ queryCode: 'a'.repeat(65), limit: 5 })).rejects.toThrow(
      '邮件查询码格式不正确'
    );
    await expect(service.query({ queryCode: 'buyer-code', limit: 21 })).rejects.toThrow(
      '返回封数必须为 1 至 20 的整数'
    );
    expect(transientState.reservePublicQuery).not.toHaveBeenCalled();
  });
});
