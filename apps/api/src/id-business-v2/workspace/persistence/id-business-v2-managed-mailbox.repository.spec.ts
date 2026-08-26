import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2ManagedMailboxRepository } from './id-business-v2-managed-mailbox.repository';

describe('IdBusinessV2ManagedMailboxRepository', () => {
  it('serializes concurrent public query reservations before enforcing the limit', async () => {
    const attempts: Array<{
      id: string;
      emailHash: string;
      ipHash: string | null;
      outcome: string;
      createdAt: Date;
    }> = [];
    let transactionQueue = Promise.resolve<unknown>(undefined);
    const prisma = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([{ locked: null }]),
      $transaction: vi.fn((callback: (client: unknown) => Promise<unknown>) => {
        const result = transactionQueue.then(() => callback(prisma));
        transactionQueue = result.then(
          () => undefined,
          () => undefined
        );
        return result;
      }),
      idBusinessV2MailQueryAttempt: {
        count: vi.fn(({ where }) =>
          Promise.resolve(
            attempts.filter(
              (attempt) =>
                attempt.createdAt >= where.createdAt.gte &&
                (where.emailHash === undefined || attempt.emailHash === where.emailHash) &&
                (where.ipHash === undefined || attempt.ipHash === where.ipHash)
            ).length
          )
        ),
        create: vi.fn(({ data }) => {
          const attempt = {
            id: `attempt-${attempts.length + 1}`,
            ...data,
            createdAt: new Date()
          };
          attempts.push(attempt);
          return Promise.resolve(attempt);
        }),
        update: vi.fn()
      }
    };
    const repository = new IdBusinessV2ManagedMailboxRepository(prisma as never);
    const input = {
      emailHash: 'e'.repeat(64),
      ipHash: 'i'.repeat(64),
      since: new Date(Date.now() - 5 * 60 * 1000),
      maxEmailAttempts: 1,
      maxIpAttempts: 40
    };

    const [first, second] = await Promise.all([
      repository.reserveQueryAttempt(input),
      repository.reserveQueryAttempt(input)
    ]);

    expect(first).toEqual({ allowed: true, attemptId: 'attempt-1' });
    expect(second).toEqual({ allowed: false });
    expect(attempts.map(({ outcome }) => outcome)).toEqual(['invalid', 'rate_limited']);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
    for (const [query] of prisma.$queryRaw.mock.calls) {
      expect(query.join('')).toContain('pg_advisory_xact_lock');
    }
  });
});
