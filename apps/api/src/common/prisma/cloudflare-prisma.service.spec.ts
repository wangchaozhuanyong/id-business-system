import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMocks = vi.hoisted(() => {
  const findMany = vi.fn().mockResolvedValue([]);
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const client = {
    idBusinessV2Account: {
      findMany
    },
    $disconnect: disconnect
  };

  return {
    client,
    disconnect,
    findMany,
    PrismaClient: vi.fn(function PrismaClient() {
      return client;
    }),
    PrismaPg: vi.fn(function PrismaPg(options: unknown) {
      return { options };
    })
  };
});

vi.mock('@cloudflare-prisma/client', () => ({
  PrismaClient: prismaMocks.PrismaClient
}));

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: prismaMocks.PrismaPg
}));

import {
  CloudflarePrismaService,
  normalizeCloudflareDatabaseConnectionString,
  runWithCloudflarePrisma
} from './cloudflare-prisma.service';

describe('CloudflarePrismaService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates Prisma calls to the request client without disconnecting it manually', async () => {
    const service = new CloudflarePrismaService() as unknown as {
      idBusinessV2Account: {
        findMany(): Promise<unknown[]>;
      };
    };

    await expect(
      runWithCloudflarePrisma(
        () => service.idBusinessV2Account.findMany(),
        'postgres://example.test/database'
      )
    ).resolves.toEqual([]);

    expect(prismaMocks.PrismaClient).toHaveBeenCalledOnce();
    expect(prismaMocks.findMany).toHaveBeenCalledOnce();
    expect(prismaMocks.disconnect).not.toHaveBeenCalled();
  });

  it('allows Nest lifecycle probing without creating a request client', () => {
    const service = new CloudflarePrismaService();

    expect(Reflect.get(service, 'onModuleInit')).toBeUndefined();
    expect(Reflect.get(service, 'then')).toBeUndefined();
    expect(() => Reflect.get(service, 'idBusinessV2Account')).toThrow(
      'Cloudflare Prisma client is only available during a request'
    );
    expect(prismaMocks.PrismaClient).not.toHaveBeenCalled();
  });

  it('keeps sslmode=require encrypted while opting into explicit libpq compatibility', () => {
    const connectionString = normalizeCloudflareDatabaseConnectionString(
      'postgresql://runtime:secret@db.example.test/app?sslmode=require&schema=public'
    );
    const url = new URL(connectionString);

    expect(url.searchParams.get('sslmode')).toBe('require');
    expect(url.searchParams.get('uselibpqcompat')).toBe('true');
    expect(url.searchParams.get('schema')).toBe('public');
  });

  it('falls back to V2_RUNTIME_DATABASE_URL when DATABASE_URL is absent', async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalRuntimeUrl = process.env.V2_RUNTIME_DATABASE_URL;
    try {
      delete process.env.DATABASE_URL;
      process.env.V2_RUNTIME_DATABASE_URL = 'postgres://runtime:secret@example.test/app';

      const service = new CloudflarePrismaService() as unknown as {
        idBusinessV2Account: {
          findMany(): Promise<unknown[]>;
        };
      };
      await expect(
        runWithCloudflarePrisma(() => service.idBusinessV2Account.findMany(), undefined)
      ).resolves.toEqual([]);
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
      if (originalRuntimeUrl === undefined) {
        delete process.env.V2_RUNTIME_DATABASE_URL;
      } else {
        process.env.V2_RUNTIME_DATABASE_URL = originalRuntimeUrl;
      }
    }
  });

  it('preserves stricter certificate verification modes', () => {
    const connectionString = normalizeCloudflareDatabaseConnectionString(
      'postgresql://runtime:secret@db.example.test/app?sslmode=verify-full'
    );

    expect(new URL(connectionString).searchParams.has('uselibpqcompat')).toBe(false);
  });
});
