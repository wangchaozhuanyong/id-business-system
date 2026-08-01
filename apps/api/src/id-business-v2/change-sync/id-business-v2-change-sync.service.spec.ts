import { describe, expect, it, vi } from 'vitest';
import { V2_DATA_SCOPES } from '@apple-business/shared';
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
    const service = new IdBusinessV2ChangeSyncService(
      new IdBusinessV2ChangeSyncRepository(prisma as never)
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
});
