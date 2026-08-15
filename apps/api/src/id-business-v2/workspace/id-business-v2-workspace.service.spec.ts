import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2WorkspaceService } from './id-business-v2-workspace.service';

const operator = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'member',
  displayName: '成员',
  roles: ['member'],
  permissions: []
};
const now = new Date('2026-08-14T20:00:00.000Z');

function shortcut(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    userId: operator.id,
    name: '工作邮箱',
    url: 'https://mail.example.com/inbox?token=secret',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe('IdBusinessV2WorkspaceService', () => {
  const tx = {};
  const repository = {
    listByUser: vi.fn(),
    countByUser: vi.fn(),
    findByIdAndUser: vi.fn(),
    findByUserAndUrl: vi.fn(),
    nextSortOrder: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    updateOrder: vi.fn()
  };
  const transactionManager = {
    execute: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx))
  };
  const audit = { append: vi.fn() };
  const service = new IdBusinessV2WorkspaceService(
    repository as never,
    transactionManager as never,
    audit as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    repository.listByUser.mockResolvedValue([shortcut()]);
    repository.countByUser.mockResolvedValue(1);
    repository.findByIdAndUser.mockResolvedValue(shortcut());
    repository.findByUserAndUrl.mockResolvedValue(null);
    repository.nextSortOrder.mockResolvedValue(1);
    repository.create.mockImplementation(async (_tx, input) => shortcut(input));
    repository.update.mockImplementation(async (_tx, id, input) => shortcut({ id, ...input }));
    repository.remove.mockResolvedValue(shortcut());
    repository.updateOrder.mockImplementation(async (_tx, _userId, ids: string[]) =>
      ids.map((id, sortOrder) => shortcut({ id, sortOrder }))
    );
    audit.append.mockResolvedValue({ id: 'audit-1' });
  });

  it('only lists shortcuts owned by the current authenticated user', async () => {
    await expect(service.list(operator)).resolves.toEqual({
      items: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          name: '工作邮箱',
          url: 'https://mail.example.com/inbox?token=secret',
          sortOrder: 0,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString()
        }
      ]
    });
    expect(repository.listByUser).toHaveBeenCalledWith(operator.id);
  });

  it('normalizes a URL and audits only its origin', async () => {
    await service.create(
      { name: ' 工作 邮箱 ', url: 'mail.example.com/inbox?token=secret' },
      operator
    );

    expect(repository.create).toHaveBeenCalledWith(tx, {
      userId: operator.id,
      name: '工作 邮箱',
      url: 'https://mail.example.com/inbox?token=secret',
      sortOrder: 1
    });
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'id_business_v2.workspace_shortcut.create',
        afterData: {
          name: '工作 邮箱',
          origin: 'https://mail.example.com',
          sortOrder: 1
        }
      })
    );
  });

  it('rejects duplicates and the per-user shortcut limit', async () => {
    repository.findByUserAndUrl.mockResolvedValueOnce(shortcut());
    await expect(
      service.create({ name: '邮箱', url: 'https://mail.example.com/inbox?token=secret' }, operator)
    ).rejects.toBeInstanceOf(ConflictException);

    repository.countByUser.mockResolvedValueOnce(20);
    await expect(
      service.create({ name: '文档', url: 'https://docs.example.com' }, operator)
    ).rejects.toThrow('每位用户最多保存 20 个快捷网址');
  });

  it('updates and deletes only an owned shortcut with an audit', async () => {
    await service.update(
      '22222222-2222-4222-8222-222222222222',
      { name: '文档', url: 'https://docs.example.com' },
      operator
    );
    expect(repository.update).toHaveBeenCalledWith(tx, shortcut().id, {
      name: '文档',
      url: 'https://docs.example.com/'
    });
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'id_business_v2.workspace_shortcut.update' })
    );

    await service.remove('22222222-2222-4222-8222-222222222222', operator);
    expect(repository.remove).toHaveBeenCalledWith(tx, shortcut().id);
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'id_business_v2.workspace_shortcut.delete' })
    );
  });

  it('rejects access to another users shortcut', async () => {
    repository.findByIdAndUser.mockResolvedValueOnce(null);
    await expect(
      service.update(
        '22222222-2222-4222-8222-222222222222',
        { name: '文档', url: 'https://docs.example.com' },
        operator
      )
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reorders the complete current-user set and rejects stale input', async () => {
    const firstId = '22222222-2222-4222-8222-222222222222';
    const secondId = '33333333-3333-4333-8333-333333333333';
    repository.listByUser.mockResolvedValueOnce([
      shortcut({ id: firstId }),
      shortcut({ id: secondId, name: '文档', url: 'https://docs.example.com/', sortOrder: 1 })
    ]);

    await expect(service.reorder({ shortcutIds: [secondId, firstId] }, operator)).resolves.toEqual({
      items: [
        expect.objectContaining({ id: secondId, sortOrder: 0 }),
        expect.objectContaining({ id: firstId, sortOrder: 1 })
      ]
    });
    expect(repository.updateOrder).toHaveBeenCalledWith(tx, operator.id, [secondId, firstId]);

    repository.listByUser.mockResolvedValueOnce([shortcut({ id: firstId })]);
    await expect(service.reorder({ shortcutIds: [firstId, secondId] }, operator)).rejects.toThrow(
      '快捷网址排序范围无效，请刷新后重试'
    );
  });

  it('rejects anonymous users, unsafe URLs and malformed ordering', async () => {
    await expect(service.list(undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create({ name: '脚本', url: 'javascript:alert(1)' }, operator)
    ).rejects.toThrow('只允许添加 HTTP 或 HTTPS 网址');
    await expect(
      service.create({ name: '带密码', url: 'https://user:pass@example.com' }, operator)
    ).rejects.toThrow('网址中不能包含账号或密码');
    await expect(
      service.reorder(
        {
          shortcutIds: [
            '22222222-2222-4222-8222-222222222222',
            '22222222-2222-4222-8222-222222222222'
          ]
        },
        operator
      )
    ).rejects.toThrow('快捷网址排序存在重复项');
  });
});
