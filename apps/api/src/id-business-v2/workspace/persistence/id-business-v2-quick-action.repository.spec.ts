import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2QuickActionRepository } from './id-business-v2-quick-action.repository';

const userId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const updatedAt = new Date('2026-09-30T10:00:00.000Z');

function fixture() {
  const records = {
    findMany: vi.fn().mockResolvedValue([]),
    aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: null } }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 })
  };
  const client = { idBusinessV2QuickAction: records };
  const repository = new IdBusinessV2QuickActionRepository(client as never);
  return { records, client, repository };
}

describe('IdBusinessV2QuickActionRepository ordering', () => {
  it('reads only active owned records and preserves the old order when all ranks are null', async () => {
    const { records, repository } = fixture();
    const rows = [
      { id, sortOrder: null },
      { id: 'older', sortOrder: null }
    ];
    records.findMany.mockResolvedValue(rows);
    await expect(repository.listByUser(userId)).resolves.toEqual(rows);
    expect(records.findMany).toHaveBeenCalledWith({
      where: { userId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }]
    });
  });

  it('keeps database ranks authoritative and appends any unranked legacy records', async () => {
    const { records, repository } = fixture();
    const unranked = { id: 'unranked', sortOrder: null };
    const first = { id: 'first', sortOrder: 0 };
    const last = { id: 'last', sortOrder: 1 };
    records.findMany.mockResolvedValue([unranked, first, last]);
    await expect(repository.listByUser(userId)).resolves.toEqual([first, last, unranked]);
  });

  it.each([
    [null, null],
    [0, 1],
    [8, 9]
  ])('uses the active user maximum %s to assign the new rank %s', async (max, expected) => {
    const { records, client, repository } = fixture();
    records.aggregate.mockResolvedValue({ _max: { sortOrder: max } });
    await expect(repository.nextSortOrder(userId, client as never)).resolves.toBe(expected);
    expect(records.aggregate).toHaveBeenCalledWith({
      where: { userId, deletedAt: null },
      _max: { sortOrder: true }
    });
  });

  it('writes only owned live rows and explicitly retains their content modification times', async () => {
    const { records, client, repository } = fixture();
    const oldTime = new Date('2026-09-29T10:00:00.000Z');
    await repository.updateOrder(client as never, userId, [
      { id, updatedAt },
      { id: 'second', updatedAt: oldTime }
    ]);
    expect(records.updateMany.mock.calls).toEqual([
      [{ where: { id, userId, deletedAt: null }, data: { sortOrder: 0, updatedAt } }],
      [
        {
          where: { id: 'second', userId, deletedAt: null },
          data: { sortOrder: 1, updatedAt: oldTime }
        }
      ]
    ]);
    expect(records.findMany).toHaveBeenCalledOnce();
  });

  it('fails the transaction if a row disappeared before the order was written', async () => {
    const { records, client, repository } = fixture();
    records.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      repository.updateOrder(client as never, userId, [{ id, updatedAt }])
    ).rejects.toBeInstanceOf(ConflictException);
    expect(records.findMany).not.toHaveBeenCalled();
  });
});
