import { BadRequestException, NotFoundException } from '@nestjs/common';
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
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides
  };
}

describe('IdBusinessV2QuickActionService', () => {
  const tx = {};
  const repository = {
    listByUser: vi.fn(),
    countByUser: vi.fn(),
    findByIdAndUser: vi.fn(),
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
      ]
    });
    expect(repository.listByUser).toHaveBeenCalledWith(operator.id);
    await expect(service.list(undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('saves multiline content and audits metadata without the reply text', async () => {
    await service.create({ title: ' 客户回复 ', content: '第一行\r\n第二行\n' }, operator);
    expect(repository.create).toHaveBeenCalledWith(tx, {
      userId: operator.id,
      title: '客户回复',
      content: '第一行\n第二行\n'
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
});
