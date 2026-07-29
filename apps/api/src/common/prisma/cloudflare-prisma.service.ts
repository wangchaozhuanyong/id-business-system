import { Injectable } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@cloudflare-prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';

const prismaRequestContext = new AsyncLocalStorage<PrismaClient>();
let supabaseEdgeClient: PrismaClient | null = null;
const NEST_LIFECYCLE_PROPERTIES = new Set<PropertyKey>([
  'then',
  'onModuleInit',
  'onApplicationBootstrap',
  'onModuleDestroy',
  'beforeApplicationShutdown',
  'onApplicationShutdown'
]);

@Injectable()
export class CloudflarePrismaService {
  constructor() {
    return new Proxy(this, {
      get(target, property, receiver) {
        if (
          typeof property === 'symbol' ||
          Reflect.has(target, property) ||
          NEST_LIFECYCLE_PROPERTIES.has(property)
        ) {
          return Reflect.get(target, property, receiver);
        }

        const client =
          prismaRequestContext.getStore() ??
          (process.env.SUPABASE_EDGE_FUNCTION === 'true'
            ? getSupabaseEdgePrismaClient()
            : undefined);
        if (!client) {
          throw new Error('Cloudflare Prisma client is only available during a request');
        }

        const value = Reflect.get(client, property, client);
        return typeof value === 'function' ? value.bind(client) : value;
      }
    });
  }
}

export async function runWithCloudflarePrisma<T>(
  callback: () => Promise<T>,
  connectionString?: string
) {
  const client = new PrismaClient(createPrismaOptions(connectionString));

  return prismaRequestContext.run(client, callback);
}

function createPrismaOptions(runtimeConnectionString?: string) {
  const connectionString = runtimeConnectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required in the Cloudflare Worker');
  }

  return {
    adapter: new PrismaPg({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000
    })
  };
}

function getSupabaseEdgePrismaClient() {
  supabaseEdgeClient ??= new PrismaClient(createPrismaOptions());
  return supabaseEdgeClient;
}
