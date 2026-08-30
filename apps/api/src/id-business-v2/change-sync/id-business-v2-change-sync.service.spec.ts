import { describe, expect, it, vi } from 'vitest';
import { V2_DATA_SCOPES } from '@apple-business/shared';
import { firstValueFrom, filter } from 'rxjs';
import { V2ChangeEventPublisher } from '../../common/prisma/v2-change-event.publisher';
import { IdBusinessV2ChangeSyncService } from './id-business-v2-change-sync.service';
import { IdBusinessV2ChangeSyncRepository } from './persistence/id-business-v2-change-sync.repository';

describe('IdBusinessV2ChangeSyncService', () => {
  it('returns every whitelisted scope with bigint versions serialized as strings', async () => {
    const prisma = {
      idBusinessV2ScopeVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            scope: 'orders',
            version: 9007199254740993n
          }
        ])
      }
    };
    const publisher = new V2ChangeEventPublisher(prisma as never);
    const service = new IdBusinessV2ChangeSyncService(
      new IdBusinessV2ChangeSyncRepository(prisma as never),
      publisher
    );

    const result = await service.getVersions();

    expect(Object.keys(result.versions).sort()).toEqual([...V2_DATA_SCOPES].sort());
    expect(result.versions.orders).toBe('9007199254740993');
    expect(result.versions.customers).toBe('0');
    expect(result.generatedAt).toEqual(expect.any(String));
    expect(prisma.idBusinessV2ScopeVersion.findMany).toHaveBeenCalledWith({
      orderBy: { scope: 'asc' },
      select: { scope: true, version: true }
    });
  });

  it('opens an SSE stream with an exact version snapshot before relying on live events', async () => {
    const prisma = {
      idBusinessV2ScopeVersion: {
        findMany: vi.fn().mockResolvedValue([{ scope: 'orders', version: 7n }])
      }
    };
    const publisher = new V2ChangeEventPublisher(prisma as never);
    const service = new IdBusinessV2ChangeSyncService(
      new IdBusinessV2ChangeSyncRepository(prisma as never),
      publisher
    );

    const message = await firstValueFrom(
      service.streamEvents().pipe(filter((event) => event.type === 'snapshot'))
    );

    expect(message.type).toBe('snapshot');
    expect(message.retry).toBe(1_000);
    expect(message.data).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        scopes: expect.arrayContaining([{ scope: 'orders', version: '7' }])
      })
    );
  });

  it('forwards committed scope versions without exposing business rows', async () => {
    const prisma = {
      idBusinessV2ScopeVersion: {
        findMany: vi
          .fn()
          .mockImplementation(async (options) =>
            options?.where ? [{ scope: 'orders', version: 8n }] : []
          )
      }
    };
    const publisher = new V2ChangeEventPublisher(prisma as never);
    const service = new IdBusinessV2ChangeSyncService(
      new IdBusinessV2ChangeSyncRepository(prisma as never),
      publisher
    );
    const changeMessage = firstValueFrom(
      service.streamEvents().pipe(filter((event) => event.type === 'change'))
    );

    await publisher.publishCommittedChange(['orders']);

    const message = await changeMessage;
    expect(message.data).toEqual(
      expect.objectContaining({
        scopes: [{ scope: 'orders', version: '8' }]
      })
    );
    expect(JSON.stringify(message.data)).not.toMatch(/phone|password|giftCard|appleId/);
  });
});
