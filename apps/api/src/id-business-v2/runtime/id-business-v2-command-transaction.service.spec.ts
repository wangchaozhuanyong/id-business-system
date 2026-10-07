import { ConflictException } from '@nestjs/common';
import { V2CommandTransactionManager } from './id-business-v2-command-transaction.service';
import { V2TransactionalAuditService } from './persistence/id-business-v2-transactional-audit.repository';
import {
  getPrismaErrorCode,
  isPrismaErrorCode,
  isWriteConflictError
} from './id-business-v2-prisma-error';

function createManager(prisma: unknown) {
  return new V2CommandTransactionManager(
    prisma as never,
    { publishCommittedChangeBestEffort: vi.fn() } as never
  );
}

describe('V2CommandTransactionManager', () => {
  it('classifies Prisma errors structurally across runtimes', () => {
    const foreignRuntimeError = { name: 'PrismaClientKnownRequestError', code: 'P2002' };

    expect(getPrismaErrorCode(foreignRuntimeError)).toBe('P2002');
    expect(isPrismaErrorCode(foreignRuntimeError, 'P2002')).toBe(true);
    expect(getPrismaErrorCode({ code: 'NOT_PRISMA' })).toBeNull();
    expect(isWriteConflictError({ code: 'P2034' })).toBe(true);
    expect(isWriteConflictError({ code: 'P2010', meta: { code: '40001' } })).toBe(true);
    expect(isWriteConflictError({ code: 'P2010', meta: { code: '1213' } })).toBe(true);
    expect(isWriteConflictError({ code: 'P2010', meta: { code: 1213 } })).toBe(true);
    expect(isWriteConflictError({ code: 'P2010', meta: { code: '1205' } })).toBe(false);
    expect(isWriteConflictError({ code: 'P2010', meta: { code: '1213-invalid' } })).toBe(false);
    expect(isWriteConflictError({ code: 'P2010', meta: { message: 'deadlock 1213' } })).toBe(false);
    expect(isWriteConflictError({ code: 'OTHER', meta: { code: '1213' } })).toBe(false);
    expect(isWriteConflictError({ code: 'P2010', meta: { code: '23505' } })).toBe(false);
  });

  it('does not retry a command by default and uses explicit serializable isolation', async () => {
    const prisma = { $transaction: vi.fn().mockRejectedValue({ code: 'P2034' }) };
    const manager = createManager(prisma);

    await expect(
      manager.execute(async () => 'created', {
        changedScopes: ['orders'],
        requestId: 'request-1'
      })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable'
    });
  });

  it('does not silently retry a raw MySQL deadlock for a command with no replay authorization', async () => {
    const publish = vi.fn();
    const prisma = {
      $transaction: vi.fn().mockRejectedValue({ code: 'P2010', meta: { code: '1213' } })
    };
    const manager = new V2CommandTransactionManager(
      prisma as never,
      {
        publishCommittedChangeBestEffort: publish
      } as never
    );
    await expect(
      manager.execute(async () => 'saved', {
        changedScopes: ['finance-ledger'],
        requestId: 'mysql-no-retry',
        retryMode: 'none'
      })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(['stableIdempotency', 'fullReplay'] as const)(
    'retries a raw MySQL deadlock only in authorized %s mode with one committed ledger, audit and event',
    async (retryMode) => {
      let committed = { ledgers: [] as string[], audits: [] as unknown[], version: 0 };
      let attempts = 0;
      const prisma = {
        $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
          attempts += 1;
          const staged = {
            ledgers: [...committed.ledgers],
            audits: [...committed.audits],
            version: committed.version
          };
          const tx = {
            ledger: {
              create: async (id: string) => {
                staged.ledgers.push(id);
              }
            },
            auditLog: {
              create: async ({ data }: { data: unknown }) => {
                staged.audits.push(data);
                return data;
              }
            },
            idBusinessV2ScopeVersion: {
              updateMany: async () => {
                staged.version += 1;
                return { count: 1 };
              }
            }
          };
          const result = await work(tx);
          if (attempts === 1) throw { code: 'P2010', meta: { code: '1213' } };
          committed = staged;
          return result;
        })
      };
      const publish = vi.fn();
      const manager = new V2CommandTransactionManager(
        prisma as never,
        {
          publishCommittedChangeBestEffort: publish
        } as never
      );
      const audit = new V2TransactionalAuditService();
      const businessTime = new Date('2026-10-04T08:00:00Z');
      const contexts: Array<{
        attempt: number;
        requestId: string;
        idempotencyKey?: string;
        businessTime: Date;
      }> = [];
      const result = await manager.execute(
        async (tx, context) => {
          contexts.push(context);
          await (
            tx as unknown as { ledger: { create: (id: string) => Promise<void> } }
          ).ledger.create('cash:one');
          await audit.append(tx, {
            module: 'id_business_v2_finance',
            action: 'synthetic.deadlock.retry',
            objectType: 'finance_journal',
            objectId: 'cash:one',
            afterData: { amount: '700' }
          });
          return context.attempt;
        },
        {
          changedScopes: ['finance-ledger'],
          requestId: 'mysql-retry',
          businessTime,
          retryMode,
          idempotencyKey: 'cash:one',
          replay: async () => 99
        }
      );
      expect(result).toBe(2);
      expect(committed.ledgers).toEqual(['cash:one']);
      expect(committed.audits).toHaveLength(1);
      expect(committed.version).toBe(1);
      expect(contexts.map((context) => context.attempt)).toEqual([1, 2]);
      expect(
        contexts.every(
          (context) =>
            context.requestId === 'mysql-retry' &&
            context.idempotencyKey === 'cash:one' &&
            context.businessTime === businessTime
        )
      ).toBe(true);
      expect(publish).toHaveBeenCalledTimes(1);
    }
  );

  it('does not classify MySQL lock timeout as an authorized deadlock retry', async () => {
    const error = { code: 'P2010', meta: { code: '1205' } };
    const prisma = { $transaction: vi.fn().mockRejectedValue(error) };
    await expect(
      createManager(prisma).execute(async () => 'saved', {
        changedScopes: ['finance-ledger'],
        requestId: 'mysql-timeout',
        retryMode: 'stableIdempotency',
        idempotencyKey: 'cash:timeout',
        replay: async () => 'replayed'
      })
    ).rejects.toBe(error);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('bumps only the declared portable scope versions in the same successful transaction', async () => {
    const tx = {
      idBusinessV2ScopeVersion: { updateMany: vi.fn().mockResolvedValue({ count: 35 }) }
    };
    const prisma = { $transaction: vi.fn(async (work) => work(tx)) };
    const manager = createManager(prisma);

    await expect(
      manager.execute(async () => 'created', {
        changedScopes: ['orders', 'orders'],
        requestId: 'request-scope'
      })
    ).resolves.toBe('created');
    expect(tx.idBusinessV2ScopeVersion.updateMany).toHaveBeenCalledWith({
      where: { scope: { in: ['orders'] } },
      data: { version: { increment: 1 }, updatedAt: expect.any(Date) }
    });
  });

  it('publishes exact scopes only after the transaction commits', async () => {
    const tx = {
      idBusinessV2ScopeVersion: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) }
    };
    const publishCommittedChangeBestEffort = vi.fn();
    const prisma = { $transaction: vi.fn(async (work) => work(tx)) };
    const manager = new V2CommandTransactionManager(
      prisma as never,
      {
        publishCommittedChangeBestEffort
      } as never
    );

    await manager.execute(async () => 'saved', {
      changedScopes: ['orders', 'orders'],
      requestId: 'request-realtime'
    });

    expect(publishCommittedChangeBestEffort).toHaveBeenCalledWith(['orders']);
  });

  it('does not publish a change event when the transaction fails', async () => {
    const publishCommittedChangeBestEffort = vi.fn();
    const prisma = { $transaction: vi.fn().mockRejectedValue(new Error('transaction failed')) };
    const manager = new V2CommandTransactionManager(
      prisma as never,
      {
        publishCommittedChangeBestEffort
      } as never
    );

    await expect(
      manager.execute(async () => 'saved', {
        changedScopes: ['orders'],
        requestId: 'request-failed'
      })
    ).rejects.toThrow('transaction failed');
    expect(publishCommittedChangeBestEffort).not.toHaveBeenCalled();
  });

  it('rejects a command without a changed scope before opening a transaction', async () => {
    const prisma = { $transaction: vi.fn() };
    const manager = createManager(prisma);

    await expect(
      manager.execute(async () => 'created', {
        changedScopes: [],
        requestId: 'request-empty-scope'
      })
    ).rejects.toThrow('requires at least one changed scope');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('retries only an explicitly replayable command and preserves command context', async () => {
    const businessTime = new Date('2026-07-31T12:00:00.000Z');
    const prisma = {
      $transaction: vi
        .fn()
        .mockRejectedValueOnce({ code: 'P2034' })
        .mockImplementationOnce(async (work) => work({ marker: 'tx-2' }))
    };
    const manager = createManager(prisma);
    const work = vi.fn(async (_tx, context) => context);

    const result = await manager.execute(work, {
      changedScopes: ['orders'],
      requestId: 'request-2',
      businessTime,
      retryMode: 'fullReplay',
      idempotencyKey: 'loss:key-2',
      replay: async () => {
        throw new Error('not used');
      }
    });

    expect(result).toMatchObject({
      attempt: 2,
      requestId: 'request-2',
      businessTime,
      idempotencyKey: 'loss:key-2'
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('retries a serializable conflict surfaced by a raw locking query', async () => {
    const prisma = {
      $transaction: vi
        .fn()
        .mockRejectedValueOnce({ code: 'P2010', meta: { code: '40001' } })
        .mockImplementationOnce(async (work) => work({ marker: 'tx-2' }))
    };
    const manager = createManager(prisma);

    await expect(
      manager.execute(async (_tx, context) => context.attempt, {
        changedScopes: ['orders'],
        requestId: 'request-raw-conflict',
        retryMode: 'fullReplay',
        idempotencyKey: 'consume:raw-conflict',
        replay: async () => 99
      })
    ).resolves.toBe(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('runs the complete P2002 replay verifier in a new transaction', async () => {
    const initialTx = { marker: 'initial' };
    const replayTx = { marker: 'replay' };
    const prisma = {
      $transaction: vi
        .fn()
        .mockImplementationOnce(async (work) => {
          await work(initialTx);
          throw { code: 'P2002' };
        })
        .mockImplementationOnce(async (work) => work(replayTx))
    };
    const replay = vi.fn(async (tx) => ({ tx, verified: true }));
    const manager = createManager(prisma);

    const result = await manager.execute(async () => ({ tx: initialTx, verified: false }), {
      changedScopes: ['orders'],
      requestId: 'request-3',
      retryMode: 'fullReplay',
      idempotencyKey: 'loss:key-3',
      replay
    });

    expect(result).toEqual({ tx: replayTx, verified: true });
    expect(replay).toHaveBeenCalledWith(
      replayTx,
      expect.objectContaining({ requestId: 'request-3', idempotencyKey: 'loss:key-3' })
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('propagates a replay verifier conflict for the same key with different parameters', async () => {
    const prisma = {
      $transaction: vi
        .fn()
        .mockRejectedValueOnce({ code: 'P2002' })
        .mockImplementationOnce(async (work) => work({ marker: 'replay' }))
    };
    const manager = createManager(prisma);

    await expect(
      manager.execute(async () => 'created', {
        changedScopes: ['orders'],
        requestId: 'request-4',
        retryMode: 'fullReplay',
        idempotencyKey: 'loss:key-4',
        replay: async () => {
          throw new ConflictException('相同幂等键对应的内容不一致');
        }
      })
    ).rejects.toThrow('相同幂等键对应的内容不一致');
  });

  it('commits nested command scopes once and closes registration before version writes', async () => {
    let mark: ((scopes: readonly ['exchange-rates']) => void) | undefined;
    const updateMany = vi.fn(async () => {
      expect(() => mark?.(['exchange-rates'])).toThrow('registration is closed');
      return { count: 2 };
    });
    const publish = vi.fn();
    const prisma = {
      $transaction: vi.fn(async (work) => work({ idBusinessV2ScopeVersion: { updateMany } }))
    };
    const manager = new V2CommandTransactionManager(
      prisma as never,
      { publishCommittedChangeBestEffort: publish } as never
    );
    await manager.execute(
      async (_tx, context) => {
        mark = context.markChangedScopes;
        context.markChangedScopes(['exchange-rates', 'orders']);
      },
      { changedScopes: ['orders'], requestId: 'nested-scopes' }
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scope: { in: ['orders', 'exchange-rates'] } } })
    );
    expect(publish).toHaveBeenCalledWith(['orders', 'exchange-rates']);
    expect(() => mark?.(['exchange-rates'])).toThrow('registration is closed');
  });

  it.each(['P2034', 'P2002'])(
    'isolates nested scopes from failed %s attempts and replay',
    async (code) => {
      const publish = vi.fn();
      const updateMany = vi.fn().mockResolvedValue({ count: 2 });
      const staleMarks: Array<() => void> = [];
      let attempts = 0;
      const prisma = {
        $transaction: vi.fn(async (work) => {
          attempts += 1;
          const result = await work({ idBusinessV2ScopeVersion: { updateMany } });
          if (attempts === 1) throw { code };
          return result;
        })
      };
      const manager = new V2CommandTransactionManager(
        prisma as never,
        { publishCommittedChangeBestEffort: publish } as never
      );
      await manager.execute(
        async (_tx, context) => {
          staleMarks.push(() => context.markChangedScopes(['exchange-rates']));
          context.markChangedScopes([context.attempt === 1 ? 'exchange-rates' : 'finance-reports']);
        },
        {
          changedScopes: ['orders'],
          requestId: 'scope-replay',
          retryMode: 'fullReplay',
          idempotencyKey: 'nested:1',
          replay: async (_tx, context) => {
            context.markChangedScopes(['finance-reports']);
          }
        }
      );
      expect(publish).toHaveBeenCalledExactlyOnceWith(['orders', 'finance-reports']);
      expect(updateMany.mock.calls.at(-1)?.[0].where.scope.in).toEqual([
        'orders',
        'finance-reports'
      ]);
      for (const stale of staleMarks) expect(stale).toThrow('registration is closed');
    }
  );

  it('does not bump or publish nested scopes after an outer command failure', async () => {
    const updateMany = vi.fn();
    const publish = vi.fn();
    const prisma = {
      $transaction: vi.fn(async (work) => work({ idBusinessV2ScopeVersion: { updateMany } }))
    };
    const manager = new V2CommandTransactionManager(
      prisma as never,
      { publishCommittedChangeBestEffort: publish } as never
    );
    await expect(
      manager.execute(
        async (_tx, context) => {
          context.markChangedScopes(['exchange-rates']);
          throw new Error('outer validation failed');
        },
        { changedScopes: ['orders'], requestId: 'nested-rollback' }
      )
    ).rejects.toThrow('outer validation failed');
    expect(updateMany).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
