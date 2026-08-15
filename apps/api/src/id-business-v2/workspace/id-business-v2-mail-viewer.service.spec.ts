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
    queryCodeHint: 'code',
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
    findByEmail: vi.fn(),
    reserveQueryAttempt: vi.fn(),
    updateQueryAttempt: vi.fn(),
    updateQueryState: vi.fn()
  };
  const encryption = {
    decrypt: vi.fn(),
    hash: vi.fn((value: string | null | undefined) => (value ? `hash:${value}` : null))
  };
  const provider = { query: vi.fn() };
  const service = new IdBusinessV2MailViewerService(
    repository as never,
    encryption as never,
    provider as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    repository.reserveQueryAttempt.mockResolvedValue({ allowed: true, attemptId: 'attempt-1' });
    repository.findByEmail.mockResolvedValue(mailbox());
    repository.updateQueryAttempt.mockResolvedValue({ id: 'attempt-1' });
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
    const result = await service.query(
      { credential: 'Member@GMAIL.COM----buyer-code', limit: 5 },
      '203.0.113.20'
    );

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
    expect(repository.updateQueryAttempt).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({ outcome: 'success', mailboxId: mailbox().id })
    );
  });

  it('returns the same generic failure for an unknown mailbox, disabled mailbox or wrong code', async () => {
    repository.findByEmail.mockResolvedValueOnce(null);
    await expect(
      service.query({ credential: 'missing@gmail.com----buyer-code', limit: 5 }, '203.0.113.20')
    ).rejects.toThrow('邮箱或邮件查询码不正确');

    repository.findByEmail.mockResolvedValueOnce(mailbox({ status: 'disabled' }));
    await expect(
      service.query({ credential: 'member@gmail.com----buyer-code', limit: 5 }, '203.0.113.20')
    ).rejects.toThrow('邮箱或邮件查询码不正确');

    repository.findByEmail.mockResolvedValueOnce(mailbox());
    await expect(
      service.query({ credential: 'member@gmail.com----wrong-code', limit: 5 }, '203.0.113.20')
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(provider.query).not.toHaveBeenCalled();
  });

  it('rate limits by email or IP before reading provider credentials', async () => {
    repository.reserveQueryAttempt.mockResolvedValueOnce({ allowed: false });
    const error = await service
      .query({ credential: 'member@gmail.com----buyer-code', limit: 5 }, '203.0.113.20')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect(repository.findByEmail).not.toHaveBeenCalled();
    expect(repository.updateQueryAttempt).not.toHaveBeenCalled();
  });

  it('marks revoked provider authorization without leaking the provider password', async () => {
    provider.query.mockRejectedValueOnce(new MailProviderAuthenticationError());
    const error = await service
      .query({ credential: 'member@gmail.com----buyer-code', limit: 5 }, '203.0.113.20')
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
      service.query({ credential: 'member@gmail.com----buyer-code', limit: 5 }, '203.0.113.20')
    ).rejects.toThrow('邮件查询服务尚未配置，请联系卖家');
  });

  it('validates combined credential and result limit before database access', async () => {
    await expect(service.query({ credential: 'member@gmail.com', limit: 5 })).rejects.toThrow(
      '格式不正确，请输入 邮箱----邮件查询码'
    );
    await expect(service.query({ credential: 'not-an-email----code', limit: 5 })).rejects.toThrow(
      '请输入有效的邮箱地址'
    );
    await expect(
      service.query({ credential: 'member@gmail.com----buyer-code', limit: 21 })
    ).rejects.toThrow('返回封数必须为 1 至 20 的整数');
    expect(repository.reserveQueryAttempt).not.toHaveBeenCalled();
  });
});
