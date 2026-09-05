import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2WebsiteVisitService } from './id-business-v2-website-visit.service';

const admin: AuthenticatedUser = {
  id: 'admin',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
function setup(configured = true) {
  const repository = {
    insert: vi.fn<(tx: unknown, data: unknown) => Promise<boolean>>(async () => true),
    find: vi.fn<
      (
        id: string,
        tx?: unknown
      ) => Promise<{
        id: string;
        occurredAt: Date;
        ipEncrypted: string;
      } | null>
    >(async () => null),
    report: vi.fn(async () => ({
      summary: { pageViews: 2, uniqueIps: 1 },
      daily: [{ date: '2026-09-06', metrics: { pageViews: 2, uniqueIps: 1 } }],
      items: [
        {
          id: '4f7989c2-b347-41f5-98e5-09a74ce303d4',
          path: '/zh',
          occurredAt: new Date('2026-09-06T01:00:00.000Z'),
          ipEncrypted: 'encrypted'
        }
      ],
      page: 1,
      lastReceivedAt: new Date('2026-09-06T01:00:01.000Z')
    })),
    expiredIds: vi.fn<(before: Date) => Promise<Array<{ id: string }>>>(async () => []),
    removeExpired: vi.fn<(tx: unknown, ids: string[], before: Date) => Promise<{ count: number }>>()
  };
  const encryption = {
    encrypt: vi.fn(() => 'encrypted'),
    decrypt: vi.fn(() => '203.0.113.19'),
    hash: vi.fn((value: string) => 'hash:' + value)
  };
  const audit = {
    append: vi.fn<(tx: unknown, input: Record<string, unknown>) => Promise<void>>(
      async () => undefined
    )
  };
  const transaction = {
    execute: vi.fn<
      (work: (tx: object) => unknown, options?: Record<string, unknown>) => Promise<unknown>
    >(async (work) => work({}))
  };
  const config = {
    get: vi.fn(() => (configured ? 'test-secret-with-at-least-thirty-two-characters' : ''))
  };
  return {
    repository,
    encryption,
    audit,
    transaction,
    service: new IdBusinessV2WebsiteVisitService(
      repository as never,
      encryption as never,
      transaction as never,
      audit as never,
      config as never
    )
  };
}

describe('website visit service', () => {
  it('encrypts and hashes the IP, then audits the created record without IP data', async () => {
    const { service, repository, audit, transaction } = setup();
    await expect(
      service.ingest({
        eventId: '4f7989c2-b347-41f5-98e5-09a74ce303d4',
        host: 'flashcast.com.my',
        path: '/zh',
        ip: '203.0.113.19',
        occurredAt: '2026-09-06T01:00:00.000Z'
      })
    ).resolves.toEqual({ accepted: true });
    expect(repository.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ipEncrypted: 'encrypted',
        ipHash: 'hash:flashcast-visit:203.0.113.19'
      })
    );
    expect(audit.append.mock.calls[0][1]).not.toHaveProperty('ip');
    expect(transaction.execute.mock.calls[0][1]).toMatchObject({ retryMode: 'stableIdempotency' });
  });

  it('keeps unconfigured and empty states distinct from a ready report', async () => {
    const missing = setup(false);
    expect(
      await missing.service.search({ days: 7, page: 1, pageSize: 20, sort: 'newest' }, admin)
    ).toMatchObject({ status: 'not_configured', summary: null });
    expect(missing.repository.report).not.toHaveBeenCalled();
    const ready = setup();
    expect(
      await ready.service.search({ days: 7, page: 1, pageSize: 20, sort: 'newest' }, admin)
    ).toMatchObject({
      status: 'ready',
      summary: { pageViews: 2, uniqueIps: 1 },
      items: [{ ipMasked: '203.0.*.*' }]
    });
  });

  it('denies non-admin reads and audits a full-IP reveal without putting the IP in audit data', async () => {
    const { service, repository, audit } = setup();
    await expect(
      service.search(
        { days: 7, page: 1, pageSize: 20, sort: 'newest' },
        { ...admin, roles: ['staff'] }
      )
    ).rejects.toThrow('仅管理员');
    repository.find.mockResolvedValueOnce({
      id: '4f7989c2-b347-41f5-98e5-09a74ce303d4',
      occurredAt: new Date(),
      ipEncrypted: 'encrypted'
    });
    await expect(service.reveal('4f7989c2-b347-41f5-98e5-09a74ce303d4', admin)).resolves.toEqual({
      ip: '203.0.113.19'
    });
    expect(audit.append.mock.calls.at(-1)?.[1]).not.toHaveProperty('ip');
  });

  it('deletes only the expired batch and records the count without IP data', async () => {
    const { service, repository, audit } = setup();
    repository.expiredIds.mockResolvedValueOnce([{ id: '4f7989c2-b347-41f5-98e5-09a74ce303d4' }]);
    repository.removeExpired.mockResolvedValueOnce({ count: 1 });

    await expect(service.removeExpired()).resolves.toBe(1);
    expect(repository.removeExpired).toHaveBeenCalledWith(
      expect.anything(),
      ['4f7989c2-b347-41f5-98e5-09a74ce303d4'],
      expect.any(Date)
    );
    expect(audit.append.mock.calls.at(-1)?.[1]).toMatchObject({ afterData: { removed: 1 } });
    expect(audit.append.mock.calls.at(-1)?.[1]).not.toHaveProperty('ip');
  });
});
