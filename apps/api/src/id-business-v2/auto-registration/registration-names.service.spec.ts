import { describe, expect, it, vi } from 'vitest';
import { RegistrationNamesService } from './registration-names.service';

const operator = { id: 'operator' } as never;

function setup() {
  const tx = {};
  const repository = {
    importNames: vi.fn(async (_tx: unknown, names: string[]) => ({ count: names.length }))
  };
  const transactions = { execute: vi.fn(async (work) => work(tx)) };
  const audit = { append: vi.fn() };
  return {
    tx,
    repository,
    transactions,
    audit,
    service: new RegistrationNamesService(
      repository as never,
      transactions as never,
      audit as never
    )
  };
}

describe('自动注册名字批量导入', () => {
  it.each([501, 2000])('允许一次导入 %i 个名字并记录数量审计', async (count) => {
    const { service, repository, audit, tx } = setup();
    const names = Array.from({ length: count }, (_, index) => `测试名字${index}`);
    await expect(service.import({ names }, operator)).resolves.toEqual({
      imported: count,
      skipped: 0
    });
    expect(repository.importNames).toHaveBeenCalledWith(tx, names);
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ afterData: { imported: count, skipped: 0 } })
    );
  });

  it('超过 2000 个时拒绝整个请求，重复名字也计入输入上限', async () => {
    const { service, repository, transactions, audit } = setup();
    await expect(service.import({ names: Array(2001).fill('重复名字') }, operator)).rejects.toThrow(
      '每次导入 1 至 2000 个名字'
    );
    expect(transactions.execute).not.toHaveBeenCalled();
    expect(repository.importNames).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('2000 个输入仍去除批内重复，并统计数据库跳过的已有名字', async () => {
    const { service, repository, audit, tx } = setup();
    const unique = Array.from({ length: 1999 }, (_, index) => `测试名字${index}`);
    repository.importNames.mockResolvedValue({ count: 1998 });
    await expect(service.import({ names: [...unique, unique[0]] }, operator)).resolves.toEqual({
      imported: 1998,
      skipped: 2
    });
    expect(repository.importNames).toHaveBeenCalledWith(tx, unique);
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ afterData: { imported: 1998, skipped: 2 } })
    );
  });

  it('仍拒绝空列表及超过 120 字符的名字，不产生写入', async () => {
    const { service, repository, transactions } = setup();
    await expect(service.import({ names: [] }, operator)).rejects.toThrow();
    await expect(service.import({ names: ['名'.repeat(121)] }, operator)).rejects.toThrow();
    expect(transactions.execute).not.toHaveBeenCalled();
    expect(repository.importNames).not.toHaveBeenCalled();
  });
});
