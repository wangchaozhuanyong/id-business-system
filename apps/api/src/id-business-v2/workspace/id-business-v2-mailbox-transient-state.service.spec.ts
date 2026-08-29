import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2MailboxTransientStateService } from './id-business-v2-mailbox-transient-state.service';

describe('IdBusinessV2MailboxTransientStateService', () => {
  let service: IdBusinessV2MailboxTransientStateService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T18:00:00.000Z'));
    service = new IdBusinessV2MailboxTransientStateService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rate limits in memory and forgets query and IP hashes after the window', () => {
    const input = {
      queryCodeHash: 'query-hash',
      ipHash: 'ip-hash',
      windowMs: 5 * 60 * 1000,
      maxQueryCodeAttempts: 1,
      maxIpAttempts: 40
    };

    expect(service.reservePublicQuery(input)).toBe(true);
    expect(service.reservePublicQuery(input)).toBe(false);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(service.reservePublicQuery(input)).toBe(true);
  });

  it('keeps Microsoft OAuth state only in process memory and prevents callback replay', () => {
    const created = service.createAuthorization({
      stateHash: 'state-hash',
      email: 'member@outlook.com',
      label: '客户 M',
      mailboxId: null,
      createdByUserId: '11111111-1111-4111-8111-111111111111',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000)
    });

    expect(created).not.toBeNull();
    const claimed = service.claimPendingAuthorization('state-hash');
    expect(claimed?.status).toBe('processing');
    expect(service.claimPendingAuthorization('state-hash')).toBeNull();
    expect(service.succeedAuthorization(created!.id, 'mailbox-id')).toBe(true);
    expect(service.findAuthorizationById(created!.id)).toMatchObject({
      email: 'member@outlook.com',
      status: 'succeeded',
      mailboxId: 'mailbox-id'
    });

    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    expect(service.findAuthorizationById(created!.id)).toBeNull();
  });

  it('expires unfinished Microsoft OAuth state without database cleanup', () => {
    const created = service.createAuthorization({
      stateHash: 'expiring-state-hash',
      email: 'member@outlook.com',
      label: null,
      mailboxId: null,
      createdByUserId: '11111111-1111-4111-8111-111111111111',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000)
    });

    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(service.findAuthorizationById(created!.id)).toMatchObject({
      status: 'failed',
      failureCode: 'expired'
    });
  });
});
