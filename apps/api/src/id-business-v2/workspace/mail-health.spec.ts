import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2VendureMailboxClient } from './providers/id-business-v2-vendure-mailbox.client';
import { IdBusinessV2VendureMailboxService } from './id-business-v2-vendure-mailbox.service';
import type { AuthenticatedUser } from '../../auth/auth.types';

const actor = { id: 'fixture-admin', roles: ['admin'] } as AuthenticatedUser;
const result = {
  checkedAt: '2026-10-16T08:00:00Z',
  listeners: [],
  delivery: {
    configured: false,
    pendingCount: 2,
    oldestPendingAt: '2026-10-16T07:00:00Z',
    lastDeliveredAt: null
  }
};
const createClient = () =>
  new IdBusinessV2VendureMailboxClient(
    new ConfigService({
      VENDURE_MAILBOX_ADMIN_API_URL: 'https://vendure.example.test/admin-api',
      VENDURE_MAILBOX_API_KEY: 'synthetic-key'
    })
  );
afterEach(() => vi.unstubAllGlobals());
describe('mail health compatibility and permissions', () => {
  it('requests only health metadata without reading mail or initiating sync', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ data: { icloudMailHealth: result } }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new IdBusinessV2VendureMailboxService(createClient(), {} as never, {} as never);
    expect(await service.health(actor)).toEqual({ ...result, status: 'available' });
    const query = JSON.parse(fetchMock.mock.calls[0]![1].body as string).query as string;
    expect(query).toContain('icloudMailHealth');
    expect(query).not.toMatch(/bodyText|extractedCode|masterQueryCode|syncIcloudAccount/);
  });
  it('an old upstream schema is explicitly unsupported, independently of list reads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          errors: [
            {
              message: 'Cannot query field "icloudMailHealth" on type "Query".',
              extensions: { code: 'GRAPHQL_VALIDATION_FAILED' }
            }
          ]
        })
      )
    );
    const service = new IdBusinessV2VendureMailboxService(createClient(), {} as never, {} as never);
    expect(await service.health(actor)).toMatchObject({
      status: 'unsupported',
      delivery: null,
      listeners: []
    });
  });
  it.each([401, 503])(
    'HTTP %s is unavailable rather than an unsupported or healthy upstream',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })));
      const service = new IdBusinessV2VendureMailboxService(
        createClient(),
        {} as never,
        {} as never
      );
      expect(await service.health(actor)).toMatchObject({ status: 'unavailable', delivery: null });
    }
  );
  it('denies non-admin health access before contacting upstream', async () => {
    const client = { mailHealth: vi.fn() };
    const service = new IdBusinessV2VendureMailboxService(
      client as never,
      {} as never,
      {} as never
    );
    await expect(service.health({ ...actor, roles: ['employee'] })).rejects.toThrow('管理员');
    expect(client.mailHealth).not.toHaveBeenCalled();
  });
});
