import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS_KEY } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { V2CommandTransaction } from '../runtime/public-api';
import { IdBusinessV2OrderArchiveService } from './id-business-v2-order-archive.service';
import { IdBusinessV2OrderBalanceReturnService } from './id-business-v2-order-balance-return.service';
import { IdBusinessV2OrderCompletionService } from './id-business-v2-order-completion.service';
import { IdBusinessV2OrderLifecycleSupport } from './id-business-v2-order-lifecycle-support';
import { IdBusinessV2OrdersController } from './id-business-v2-orders.controller';

const id = '11111111-1111-4111-8111-111111111111';
const actor = { id: '22222222-2222-4222-8222-222222222222' } as AuthenticatedUser;
const stamp = new Date('2026-10-05T12:00:00.000Z');

function fixture(status = 'completed') {
  const state = {
    id,
    orderNo: 'ARCHIVE-SYNTHETIC',
    status,
    updatedAt: new Date(stamp),
    archivedAt: null as Date | null,
    deletedAt: null as Date | null,
    receivedAmount: '100',
    profitAmount: '57',
    accountId: 'original-account',
    sourceSoldOrderId: 'original-source',
    updatedByUserId: 'original-operator'
  };
  const receipts = new Map<string, { afterData: unknown }>();
  const repository = {
    lockOrderId: vi.fn(async () => (state.deletedAt ? null : { id })),
    findOrderInTransaction: vi.fn(async () => structuredClone(state)),
    lockOrder: vi.fn(async () => structuredClone(state)),
    findArchiveCommand: vi.fn(async (_tx, _id, key) => receipts.get(key) ?? null),
    findValidLockForOrder: vi.fn(async () => null as unknown),
    updateOrder: vi.fn(async (_tx, _id, data) => {
      Object.assign(state, data);
      return structuredClone(state);
    }),
    appendAudit: vi.fn(async (_tx, data) => {
      receipts.set(data.afterData.archiveCommand.idempotencyKey, { afterData: data.afterData });
      return { id: 'audit-proof' };
    }),
    createBalanceLedger: vi.fn(),
    updateAccount: vi.fn(),
    findSourceOrderReference: vi.fn()
  };
  const transactions = {
    execute: vi.fn(
      async (
        run: (tx: V2CommandTransaction, context: { businessTime: Date }) => unknown,
        options?: unknown
      ) => {
        void options;
        return run({} as V2CommandTransaction, { businessTime: stamp });
      }
    )
  };
  const dto = {
    expectedUpdatedAt: stamp.toISOString(),
    reason: '整理已结束订单',
    idempotencyKey: 'archive-command-0001'
  };
  return {
    state,
    repository,
    transactions,
    dto,
    service: new IdBusinessV2OrderArchiveService(repository as never, transactions as never)
  };
}

describe('IdBusinessV2OrderArchiveService', () => {
  it.each(['completed', 'refunded', 'cancelled', 'failed'])(
    'archives %s while preserving every business field and related source',
    async (status) => {
      const f = fixture(status);
      const before = structuredClone(f.state);
      const result = await f.service.archive(id, f.dto, actor);
      expect(result).toMatchObject({ id, idempotentReplay: false });
      expect(new Date(result.updatedAt).getTime()).toBe(stamp.getTime() + 1);
      expect({ ...f.state, archivedAt: before.archivedAt, updatedAt: before.updatedAt }).toEqual(
        before
      );
      expect(f.repository.updateOrder).toHaveBeenCalledWith(expect.anything(), id, {
        archivedAt: expect.any(Date),
        updatedAt: expect.any(Date)
      });
      expect(f.repository.createBalanceLedger).not.toHaveBeenCalled();
      expect(f.repository.updateAccount).not.toHaveBeenCalled();
      expect(f.repository.findSourceOrderReference).not.toHaveBeenCalled();
      expect(f.transactions.execute.mock.calls[0]?.[1]).toMatchObject({
        changedScopes: ['orders'],
        retryMode: 'none'
      });
      expect(f.repository.appendAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'id_business_v2.order.archive',
          objectId: id,
          userId: actor.id,
          beforeData: expect.objectContaining({ archivedAt: null, status }),
          afterData: expect.objectContaining({
            archivedAt: result.archivedAt,
            updatedAt: result.updatedAt,
            status,
            dataPreserved: true
          })
        })
      );
    }
  );

  it.each(['draft', 'pending', 'waiting_external', 'processing'])(
    'rejects %s without writing or releasing business data',
    async (status) => {
      const f = fixture(status);
      await expect(f.service.archive(id, f.dto, actor)).rejects.toBeInstanceOf(ConflictException);
      expect(f.repository.updateOrder).not.toHaveBeenCalled();
      expect(f.repository.appendAudit).not.toHaveBeenCalled();
    }
  );

  it('replays the exact stale-version request once without a second mutation or audit', async () => {
    const f = fixture();
    const first = await f.service.archive(id, f.dto, actor);
    expect(await f.service.archive(id, f.dto, actor)).toEqual({ ...first, idempotentReplay: true });
    expect(f.repository.updateOrder).toHaveBeenCalledTimes(1);
    expect(f.repository.appendAudit).toHaveBeenCalledTimes(1);
  });

  it('rejects a terminal target with a valid business lock without releasing the lock', async () => {
    const f = fixture();
    f.repository.findValidLockForOrder.mockResolvedValue({ id: 'active-target-lock' });
    await expect(f.service.archive(id, f.dto, actor)).rejects.toThrow('有效业务占用');
    expect(f.repository.findValidLockForOrder).toHaveBeenCalledWith(expect.anything(), id, stamp);
    expect(f.repository.updateOrder).not.toHaveBeenCalled();
    expect(f.repository.appendAudit).not.toHaveBeenCalled();
    expect(f.repository.createBalanceLedger).not.toHaveBeenCalled();
    expect(f.repository.updateAccount).not.toHaveBeenCalled();
  });

  it('allows restoring visibility even if an archived target acquired a valid lock', async () => {
    const f = fixture();
    f.state.archivedAt = stamp;
    f.repository.findValidLockForOrder.mockResolvedValue({ id: 'active-target-lock' });
    await expect(f.service.unarchive(id, f.dto, actor)).resolves.toMatchObject({
      archivedAt: null
    });
    expect(f.repository.findValidLockForOrder).not.toHaveBeenCalled();
  });

  it.each(['reason', 'expectedUpdatedAt', 'action', 'operator'])(
    'rejects changed %s on a reused idempotency key',
    async (field) => {
      const f = fixture();
      await f.service.archive(id, f.dto, actor);
      const dto = {
        ...f.dto,
        ...(field === 'reason' ? { reason: '不同确认原因' } : {}),
        ...(field === 'expectedUpdatedAt'
          ? { expectedUpdatedAt: f.state.updatedAt.toISOString() }
          : {})
      };
      const user =
        field === 'operator' ? { ...actor, id: '33333333-3333-4333-8333-333333333333' } : actor;
      const operation =
        field === 'action'
          ? f.service.unarchive.bind(f.service)
          : f.service.archive.bind(f.service);
      await expect(operation(id, dto, user)).rejects.toBeInstanceOf(ConflictException);
      expect(f.repository.updateOrder).toHaveBeenCalledTimes(1);
    }
  );

  it('rejects a fresh command with an old version and safely restores with the current version', async () => {
    const f = fixture();
    const before = structuredClone(f.state);
    await f.service.archive(id, f.dto, actor);
    await expect(
      f.service.unarchive(id, { ...f.dto, idempotencyKey: 'unarchive-command-0001' }, actor)
    ).rejects.toBeInstanceOf(ConflictException);
    const restore = {
      ...f.dto,
      expectedUpdatedAt: f.state.updatedAt.toISOString(),
      idempotencyKey: 'unarchive-command-0002'
    };
    const result = await f.service.unarchive(id, restore, actor);
    expect(result.archivedAt).toBeNull();
    expect(f.state.archivedAt).toBeNull();
    expect({ ...f.state, updatedAt: before.updatedAt }).toEqual(before);
    expect(await f.service.unarchive(id, restore, actor)).toEqual({
      ...result,
      idempotentReplay: true
    });
    expect(f.repository.updateOrder).toHaveBeenCalledTimes(2);
    expect(f.repository.appendAudit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'id_business_v2.order.unarchive',
        beforeData: expect.objectContaining({
          archivedAt: expect.any(String),
          status: 'completed'
        }),
        afterData: expect.objectContaining({
          archivedAt: null,
          updatedAt: result.updatedAt,
          status: 'completed',
          outcome: expect.objectContaining({ archivedAt: null })
        })
      })
    );
  });

  it('rejects deleted orders and active orders that are not archived', async () => {
    const f = fixture();
    await expect(f.service.unarchive(id, f.dto, actor)).rejects.toBeInstanceOf(ConflictException);
    f.state.deletedAt = stamp;
    await expect(f.service.archive(id, f.dto, actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.repository.updateOrder).not.toHaveBeenCalled();
  });

  it.each([
    { reason: '' },
    { expectedUpdatedAt: 'invalid' },
    { idempotencyKey: 'short' },
    { status: 'completed' }
  ])('rejects malformed confirmation %j before the transaction', async (override) => {
    const f = fixture();
    await expect(f.service.archive(id, { ...f.dto, ...override }, actor)).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(f.transactions.execute).not.toHaveBeenCalled();
  });

  it('reuses existing order-update permission for both commands', () => {
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, IdBusinessV2OrdersController.prototype.archive)
    ).toEqual(['apple.order.update']);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, IdBusinessV2OrdersController.prototype.unarchive)
    ).toEqual(['apple.order.update']);
  });

  it('keeps archived source reads available while rejecting target lifecycle writes and delete', async () => {
    const f = fixture();
    f.state.archivedAt = stamp;
    const support = new IdBusinessV2OrderLifecycleSupport(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      f.transactions as never,
      f.repository as never
    );
    await expect(support.lockOrder({} as V2CommandTransaction, id, true)).resolves.toMatchObject({
      id,
      archivedAt: stamp
    });
    await expect(support.lockOrder({} as V2CommandTransaction, id)).rejects.toThrow('先恢复');
    await expect(support.remove(id, { reason: '删除前先恢复' }, actor)).rejects.toThrow('先恢复');
    expect(f.repository.updateOrder).not.toHaveBeenCalled();
  });

  it('blocks completion and upgrade-return mutations before accessing balances or journals', async () => {
    const f = fixture();
    f.state.archivedAt = stamp;
    const completion = new IdBusinessV2OrderCompletionService(
      {} as never,
      {} as never,
      f.repository as never,
      f.transactions as never
    );
    await expect(completion.complete(id, actor)).rejects.toThrow('先恢复');
    const returns = new IdBusinessV2OrderBalanceReturnService(
      {} as never,
      {} as never,
      {} as never,
      f.repository as never,
      f.transactions as never
    );
    await expect(
      returns.record(
        id,
        {
          returnedBalanceAmount: '1',
          reason: '升级返还余额',
          idempotencyKey: 'balance-return-command'
        },
        actor
      )
    ).rejects.toThrow('先恢复');
    await expect(
      returns.reverse(
        id,
        { reason: '撤回余额返还', idempotencyKey: 'balance-return-reverse' },
        actor
      )
    ).rejects.toThrow('先恢复');
    expect(f.repository.createBalanceLedger).not.toHaveBeenCalled();
    expect(f.repository.updateAccount).not.toHaveBeenCalled();
    expect(f.repository.updateOrder).not.toHaveBeenCalled();
  });
});
