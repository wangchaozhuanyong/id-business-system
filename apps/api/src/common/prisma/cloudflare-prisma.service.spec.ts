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

import { CloudflarePrismaService, runWithCloudflarePrisma } from './cloudflare-prisma.service';

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
});
