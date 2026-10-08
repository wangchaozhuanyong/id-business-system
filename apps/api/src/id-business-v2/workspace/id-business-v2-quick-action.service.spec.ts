import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2QuickActionService } from './id-business-v2-quick-action.service';

const operator = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'member',
  displayName: '成员',
  roles: ['member'],
  permissions: []
};
const now = new Date('2026-09-30T10:00:00.000Z');
const id = '22222222-2222-4222-8222-222222222222';
const content = '您好，确认订单前请核对资料。\n谢谢。';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id,
    userId: operator.id,
    title: '客户回复',
    content,
    sortOrder: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides
  };
}

type OrderedQuickActionRow = Omit<ReturnType<typeof row>, 'sortOrder'> & {
  sortOrder: number | null;
};

describe('IdBusinessV2QuickActionService', () => {
  const tx = {};
  const repository = {
    listByUser: vi.fn(),
    countByUser: vi.fn(),
    findByIdAndUser: vi.fn(),
    nextSortOrder: vi.fn(),
    updateOrder: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn()
  };
  const transactionManager = {
    execute: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx))
  };
  const audit = { append: vi.fn() };
  const service = new IdBusinessV2QuickActionService(
    repository as never,
    transactionManager as never,
    audit as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    repository.listByUser.mockResolvedValue([row()]);
    repository.countByUser.mockResolvedValue(1);
    repository.findByIdAndUser.mockResolvedValue(row());
    repository.nextSortOrder.mockResolvedValue(null);
    repository.updateOrder.mockImplementation(
      async (_tx: unknown, _userId: string, rows: OrderedQuickActionRow[]) =>
        rows.map((item, sortOrder) => ({ ...item, sortOrder }))
    );
    repository.create.mockImplementation(async (_tx, input) => row(input));
    repository.update.mockImplementation(async (_tx, _id, input) => row(input));
    repository.softDelete.mockResolvedValue(row({ deletedAt: now }));
    audit.append.mockResolvedValue({ id: 'audit-1' });
  });

  it('reads only the signed-in user and returns the saved content for copying', async () => {
    await expect(service.list(operator)).resolves.toEqual({
      items: [
        {
          id,
          title: '客户回复',
          content,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString()
        }
      ],
      hasCustomOrder: false
    });
    expect(repository.listByUser).toHaveBeenCalledWith(operator.id);
    await expect(service.list(undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('saves multiline content and audits metadata without the reply text', async () => {
    await service.create({ title: ' 客户回复 ', content: '第一行\r\n第二行\n' }, operator);
    expect(repository.create).toHaveBeenCalledWith(tx, {
      userId: operator.id,
      title: '客户回复',
      content: '第一行\n第二行\n',
      sortOrder: null
    });
    const auditInput = audit.append.mock.calls[0]?.[1];
    expect(auditInput).toEqual(
      expect.objectContaining({
        action: 'id_business_v2.quick_action.create',
        objectId: id,
        afterData: { titleLength: 4, contentLength: 8 }
      })
    );
    expect(JSON.stringify(auditInput)).not.toContain('第一行');
  });

  it('updates and soft deletes only an owned row with audit entries', async () => {
    await service.update(id, { title: '更新', content: '新内容' }, operator);
    expect(repository.findByIdAndUser).toHaveBeenCalledWith(id, operator.id, tx);
    expect(repository.update).toHaveBeenCalledWith(tx, id, { title: '更新', content: '新内容' });
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'id_business_v2.quick_action.update' })
    );

    await service.remove(id, operator);
    expect(repository.softDelete).toHaveBeenCalledWith(tx, id);
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'id_business_v2.quick_action.delete' })
    );
  });

  it('rejects another user row and invalid input', async () => {
    repository.findByIdAndUser.mockResolvedValueOnce(null);
    await expect(
      service.update(id, { title: '更新', content: '新内容' }, operator)
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.create({ title: ' ', content: content }, operator)).rejects.toThrow(
      '标题长度'
    );
    await expect(service.create({ title: '标题', content: '  ' }, operator)).rejects.toThrow(
      '内容长度'
    );
    await expect(service.remove('bad-id', operator)).rejects.toThrow('标识无效');
    repository.countByUser.mockResolvedValueOnce(200);
    await expect(service.create({ title: '标题', content }, operator)).rejects.toThrow(
      '最多保存 200 条'
    );
  });

  it('marks the first custom order even when it matches the default order', async () => {
    const result = await service.reorder(
      { quickActionIds: [id], expectedQuickActionIds: [id] },
      operator,
      'request-order'
    );
    expect(result.hasCustomOrder).toBe(true);
    expect(repository.updateOrder).toHaveBeenCalledWith(tx, operator.id, [row()]);
    expect(transactionManager.execute).toHaveBeenCalledWith(expect.any(Function), {
      changedScopes: ['workspace'],
      requestId: 'request-order',
      operator,
      retryMode: 'none'
    });
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'id_business_v2.quick_action.reorder',
        userId: operator.id,
        objectId: operator.id,
        beforeData: { quickActionIds: [id] },
        afterData: { quickActionIds: [id] }
      })
    );
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain(content);
  });

  it('persists the complete owned order and returns the database result', async () => {
    const secondId = '33333333-3333-4333-8333-333333333333';
    const second = row({ id: secondId, updatedAt: new Date('2026-09-29T10:00:00Z') });
    repository.listByUser.mockResolvedValue([row(), second]);
    const result = await service.reorder(
      { quickActionIds: [secondId, id], expectedQuickActionIds: [id, secondId] },
      operator
    );
    expect(repository.listByUser).toHaveBeenCalledWith(operator.id, tx);
    expect(repository.updateOrder).toHaveBeenCalledWith(tx, operator.id, [second, row()]);
    expect(result.items.map((item) => item.id)).toEqual([secondId, id]);
    expect(result.items.map((item) => item.updatedAt)).toEqual([
      second.updatedAt.toISOString(),
      now.toISOString()
    ]);
    expect(result.hasCustomOrder).toBe(true);
  });

  it('returns 409 for a stale expected order and does not write or audit', async () => {
    const secondId = '33333333-3333-4333-8333-333333333333';
    repository.listByUser.mockResolvedValue([
      row({ id: secondId, sortOrder: 0 }),
      row({ sortOrder: 1 })
    ]);
    await expect(
      service.reorder(
        { quickActionIds: [id, secondId], expectedQuickActionIds: [id, secondId] },
        operator
      )
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.updateOrder).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it.each([
    { quickActionIds: [], expectedQuickActionIds: [id] },
    { quickActionIds: [id], expectedQuickActionIds: [] },
    { quickActionIds: ['44444444-4444-4444-8444-444444444444'], expectedQuickActionIds: [id] }
  ])('rejects a changed, deleted or foreign ID set: %j', async (dto) => {
    await expect(service.reorder(dto, operator)).rejects.toBeInstanceOf(ConflictException);
    expect(repository.updateOrder).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it.each([
    { quickActionIds: null, expectedQuickActionIds: [id] },
    { quickActionIds: [id], expectedQuickActionIds: null },
    { quickActionIds: ['bad-id'], expectedQuickActionIds: [id] },
    { quickActionIds: [id], expectedQuickActionIds: ['bad-id'] },
    { quickActionIds: [id, id], expectedQuickActionIds: [id] },
    { quickActionIds: [id], expectedQuickActionIds: [id, id] },
    { quickActionIds: Array(201).fill(id), expectedQuickActionIds: [id] },
    { quickActionIds: [id], expectedQuickActionIds: Array(201).fill(id) },
    { quickActionIds: [id], expectedQuickActionIds: [id], initializeOnly: 'true' }
  ])('rejects an invalid order request before starting a transaction: %j', async (dto) => {
    await expect(service.reorder(dto, operator)).rejects.toBeInstanceOf(BadRequestException);
    expect(transactionManager.execute).not.toHaveBeenCalled();
  });

  it('requires a signed-in user for sorting', async () => {
    await expect(
      service.reorder({ quickActionIds: [id], expectedQuickActionIds: [id] })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transactionManager.execute).not.toHaveBeenCalled();
  });

  it('keeps the first database initialization authoritative over another device', async () => {
    const secondId = '33333333-3333-4333-8333-333333333333';
    repository.listByUser.mockResolvedValue([
      row({ id: secondId, sortOrder: 0 }),
      row({ sortOrder: 1 })
    ]);
    const result = await service.reorder(
      { quickActionIds: [id], expectedQuickActionIds: [id], initializeOnly: true },
      operator
    );
    expect(result.items.map((item) => item.id)).toEqual([secondId, id]);
    expect(result.hasCustomOrder).toBe(true);
    expect(repository.updateOrder).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('does not rewrite or audit an unchanged custom order', async () => {
    repository.listByUser.mockResolvedValue([row({ sortOrder: 0 })]);
    const result = await service.reorder(
      { quickActionIds: [id], expectedQuickActionIds: [id] },
      operator
    );
    expect(result.hasCustomOrder).toBe(true);
    expect(repository.updateOrder).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('keeps an empty list uninitialized', async () => {
    repository.listByUser.mockResolvedValue([]);
    await expect(
      service.reorder({ quickActionIds: [], expectedQuickActionIds: [] }, operator)
    ).resolves.toEqual({ items: [], hasCustomOrder: false });
    expect(repository.updateOrder).not.toHaveBeenCalled();
  });

  it('appends a new reply after the saved custom order', async () => {
    repository.nextSortOrder.mockResolvedValue(7);
    await service.create({ title: '新增', content: '内容' }, operator);
    expect(repository.nextSortOrder).toHaveBeenCalledWith(operator.id, tx);
    expect(repository.create).toHaveBeenCalledWith(tx, {
      userId: operator.id,
      title: '新增',
      content: '内容',
      sortOrder: 7
    });
  });

  it('does not change the custom rank when the reply text is edited', async () => {
    repository.findByIdAndUser.mockResolvedValue(row({ sortOrder: 4 }));
    await service.update(id, { title: '更新', content: '新内容' }, operator);
    expect(repository.update).toHaveBeenCalledWith(tx, id, { title: '更新', content: '新内容' });
    expect(repository.updateOrder).not.toHaveBeenCalled();
  });

  it('reads a saved user order from another service instance without sharing local state', async () => {
    const secondId = '33333333-3333-4333-8333-333333333333';
    let savedRows: OrderedQuickActionRow[] = [
      row({ sortOrder: null }),
      row({ id: secondId, sortOrder: null })
    ];
    repository.listByUser.mockImplementation(async (userId) =>
      userId === operator.id ? savedRows : []
    );
    repository.updateOrder.mockImplementation(
      async (_tx: unknown, _userId: string, orderedRows: OrderedQuickActionRow[]) => {
        savedRows = orderedRows.map((item, sortOrder) => ({ ...item, sortOrder }));
        return savedRows;
      }
    );
    const anotherComputer = new IdBusinessV2QuickActionService(
      { listByUser: repository.listByUser } as never,
      transactionManager as never,
      audit as never
    );
    await service.reorder(
      { quickActionIds: [secondId, id], expectedQuickActionIds: [id, secondId] },
      operator
    );
    const result = await anotherComputer.list(operator);
    expect(result.items.map((item) => item.id)).toEqual([secondId, id]);
    expect(result.hasCustomOrder).toBe(true);
    await expect(
      anotherComputer.list({ ...operator, id: '44444444-4444-4444-8444-444444444444' })
    ).resolves.toEqual({ items: [], hasCustomOrder: false });
  });
});
