import { ConflictException } from '@nestjs/common';
import { V2CommandTransactionManager } from './id-business-v2-command-transaction.service';
import {
  getPrismaErrorCode,
  isPrismaErrorCode,
  isWriteConflictError
} from './id-business-v2-prisma-error';

describe('V2CommandTransactionManager', () => {
  it('classifies Prisma errors structurally across runtimes', () => {
    const foreignRuntimeError = { name: 'PrismaClientKnownRequestError', code: 'P2002' };

    expect(getPrismaErrorCode(foreignRuntimeError)).toBe('P2002');
    expect(isPrismaErrorCode(foreignRuntimeError, 'P2002')).toBe(true);
    expect(getPrismaErrorCode({ code: 'NOT_PRISMA' })).toBeNull();
    expect(isWriteConflictError({ code: 'P2034' })).toBe(true);
    expect(isWriteConflictError({ code: 'P2010', meta: { code: '40001' } })).toBe(true);
    expect(isWriteConflictError({ code: 'P2010', meta: { code: '23505' } })).toBe(false);
  });

  it('does not retry a command by default and uses explicit serializable isolation', async () => {
    const prisma = { $transaction: vi.fn().mockRejectedValue({ code: 'P2034' }) };
    const manager = new V2CommandTransactionManager(prisma as never);

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

  it('bumps only the declared portable scope versions in the same successful transaction', async () => {
    const tx = {
      idBusinessV2ScopeVersion: { updateMany: vi.fn().mockResolvedValue({ count: 35 }) }
    };
    const prisma = { $transaction: vi.fn(async (work) => work(tx)) };
    const manager = new V2CommandTransactionManager(prisma as never);

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

  it('rejects a command without a changed scope before opening a transaction', async () => {
    const prisma = { $transaction: vi.fn() };
    const manager = new V2CommandTransactionManager(prisma as never);

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
    const manager = new V2CommandTransactionManager(prisma as never);
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
    const manager = new V2CommandTransactionManager(prisma as never);

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
    const manager = new V2CommandTransactionManager(prisma as never);

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
    const manager = new V2CommandTransactionManager(prisma as never);

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
});
