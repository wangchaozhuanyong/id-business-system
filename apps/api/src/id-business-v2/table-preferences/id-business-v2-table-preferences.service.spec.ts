import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2TablePreferencesService } from './id-business-v2-table-preferences.service';

const operator = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'member',
  displayName: '成员',
  roles: ['member'],
  permissions: []
};
const now = new Date('2026-08-08T00:00:00.000Z');

function preference(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    userId: operator.id,
    tableId: 'orders.main',
    hiddenColumnKeys: ['客户', '供应商'],
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe('IdBusinessV2TablePreferencesService', () => {
  const tx = {};
  const repository = {
    listByUser: vi.fn(),
    findByUserAndTable: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn()
  };
  const transactionManager = {
    execute: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx))
  };
  const audit = { append: vi.fn() };
  const service = new IdBusinessV2TablePreferencesService(
    repository as never,
    transactionManager as never,
    audit as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    repository.listByUser.mockResolvedValue([preference()]);
    repository.findByUserAndTable.mockResolvedValue(preference());
    repository.upsert.mockImplementation(async (_tx, input) => preference(input));
    repository.remove.mockResolvedValue(preference());
    audit.append.mockResolvedValue({ id: 'audit-1' });
  });

  it('only lists preferences owned by the current authenticated user', async () => {
    await expect(service.list(operator)).resolves.toEqual({
      items: [
        {
          tableId: 'orders.main',
          hiddenColumnKeys: ['客户', '供应商'],
          updatedAt: now.toISOString()
        }
      ]
    });
    expect(repository.listByUser).toHaveBeenCalledWith(operator.id);
  });

  it('normalizes duplicate column keys and atomically writes the preference and audit', async () => {
    await expect(
      service.update('orders.main', { hiddenColumnKeys: [' 客户 ', '供应商', '客户'] }, operator)
    ).resolves.toMatchObject({
      tableId: 'orders.main',
      hiddenColumnKeys: ['客户', '供应商']
    });

    expect(repository.upsert).toHaveBeenCalledWith(tx, {
      userId: operator.id,
      tableId: 'orders.main',
      hiddenColumnKeys: ['客户', '供应商']
    });
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        userId: operator.id,
        action: 'id_business_v2.table_preferences.update',
        beforeData: { tableId: 'orders.main', hiddenColumnKeys: ['客户', '供应商'] },
        afterData: { tableId: 'orders.main', hiddenColumnKeys: ['客户', '供应商'] }
      })
    );
  });

  it('deletes an existing preference and records a reset audit', async () => {
    await expect(service.reset('orders.main', operator)).resolves.toEqual({
      tableId: 'orders.main',
      hiddenColumnKeys: [],
      deleted: true
    });
    expect(repository.remove).toHaveBeenCalledWith(tx, '22222222-2222-4222-8222-222222222222');
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'id_business_v2.table_preferences.reset' })
    );
  });

  it('keeps reset idempotent when no preference exists', async () => {
    repository.findByUserAndTable.mockResolvedValue(null);
    await expect(service.reset('orders.main', operator)).resolves.toEqual({
      tableId: 'orders.main',
      hiddenColumnKeys: [],
      deleted: false
    });
    expect(repository.remove).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('rejects anonymous users, invalid table ids and malformed column payloads', async () => {
    await expect(service.list(undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update('../orders', { hiddenColumnKeys: [] }, operator)).rejects.toThrow(
      '数据表标识无效'
    );
    await expect(
      service.update('orders.main', { hiddenColumnKeys: '客户' }, operator)
    ).rejects.toThrow('隐藏列设置必须是数组');
    await expect(
      service.update('orders.main', { hiddenColumnKeys: ['\u0000'] }, operator)
    ).rejects.toThrow('隐藏列标识无效');
  });
});
