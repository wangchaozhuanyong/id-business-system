import { describe, expect, it, vi } from 'vitest';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { RechargeService } from './recharge.service';

const operator = {
  id: 'admin-test',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};

function authorizationClient() {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
    securitySetting: { findUnique: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn().mockResolvedValue({ status: 'active', deletedAt: null }) }
  };
}

describe('auto recharge address service', () => {
  it.each(['unused', 'all'] as const)('地址分配顺序由服务端分页前排序：%s', async (status) => {
    const model = { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) };
    const prisma = {
      ...authorizationClient(),
      idBusinessV2RechargeAddress: model,
      $transaction: vi.fn(async (reads) => Promise.all(reads))
    };
    const repository = new RechargeAddressRepository(prisma as never);
    await repository.list(operator.id, { page: 1, pageSize: 2000, keyword: '', status });
    expect(model.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy:
          status === 'unused'
            ? [{ createdAt: 'asc' }, { id: 'asc' }]
            : [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 2000
      })
    );
  });

  it('generates an owned batch with aggregate audit in the same transaction', async () => {
    const tx = {};
    const items = [{ id: 'new-address', status: 'unused', ownerId: operator.id }];
    const repository = { generate: vi.fn().mockResolvedValue(items) };
    const audit = { append: vi.fn() };
    const transactions = { execute: vi.fn(async (work) => work(tx)) };
    const service = new RechargeService(
      {} as never,
      repository as never,
      transactions as never,
      audit as never
    );
    expect(await service.generateAddresses({ count: 1 }, operator)).toEqual({ count: 1, items });
    expect(repository.generate).toHaveBeenCalledWith(tx, operator.id, 1);
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'id_business_v2.auto_recharge.addresses.generate',
        afterData: { count: 1, ids: ['new-address'] }
      })
    );
    expect(transactions.execute).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        operator,
        changedScopes: ['auto-recharge'],
        retryMode: 'none'
      })
    );
    audit.append.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(service.generateAddresses({ count: 1 }, operator)).rejects.toThrow(
      'audit unavailable'
    );
    await expect(service.generateAddresses({ count: 101 }, operator)).rejects.toThrow();
    expect(repository.generate).toHaveBeenCalledTimes(2);
  });

  it('only returns new owned rows and replaces unique street collisions without updating history', async () => {
    const stored: { id: string; ownerId: string; line1: string; status: string }[] = [];
    const model = {
      createMany: vi.fn(async ({ data }) => {
        // Simulate one collision with a pre-existing disabled street on the first batch.
        stored.push(...(stored.length ? data : data.slice(1)));
      }),
      findMany: vi.fn(async ({ where }) =>
        stored.filter((item) => item.ownerId === where.ownerId && where.id.in.includes(item.id))
      )
    };
    const tx = { ...authorizationClient(), idBusinessV2RechargeAddress: model };
    const repository = new RechargeAddressRepository({} as never);
    const items = await repository.generate(tx as never, operator.id, 2);
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.ownerId === operator.id && item.status === 'unused')).toBe(
      true
    );
    expect(model.createMany).toHaveBeenCalledTimes(2);
    expect(model.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
    expect(model.findMany.mock.calls[0][0].where).toEqual({
      ownerId: operator.id,
      id: { in: expect.any(Array) }
    });
  });

  it('bounds collision retries and surfaces a transactional failure rather than a partial batch', async () => {
    const tx = {
      ...authorizationClient(),
      idBusinessV2RechargeAddress: {
        createMany: vi.fn(),
        findMany: vi.fn().mockResolvedValue([])
      }
    };
    const repository = new RechargeAddressRepository({} as never);
    await expect(repository.generate(tx as never, operator.id, 10)).rejects.toThrow('街道重复');
    expect(tx.idBusinessV2RechargeAddress.createMany).toHaveBeenCalledTimes(3);
  });
  it('imports only normalized unique streets and audits aggregate counts', async () => {
    const addressRepository = {
      createMany: vi.fn().mockResolvedValue({ count: 1 })
    };
    const audit = { append: vi.fn().mockResolvedValue({ id: 'audit' }) };
    const transactions = {
      execute: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({}))
    };
    const service = new RechargeService(
      {} as never,
      addressRepository as never,
      transactions as never,
      audit as never
    );

    await expect(
      service.importAddresses(
        { streets: ['1221 SW Fourth Avenue', '1221  SW Fourth Avenue', ''] },
        operator
      )
    ).resolves.toEqual({ imported: 1, duplicated: 1, rejected: 1 });
    expect(addressRepository.createMany).toHaveBeenCalledWith({}, operator.id, [
      '1221 SW Fourth Avenue'
    ]);
    expect(audit.append.mock.calls[0]?.[1].afterData).toEqual({
      imported: 1,
      duplicated: 1,
      rejected: 1,
      location: { country: 'US', city: 'Portland', state: 'OR', postalCode: '97204' }
    });
  });

  it('does not allow a used address to become reusable', async () => {
    const repository = new RechargeAddressRepository({} as never);
    const tx = {
      ...authorizationClient(),
      idBusinessV2RechargeAddress: {
        findFirst: vi.fn().mockResolvedValue({ id: 'address', status: 'used' }),
        update: vi.fn()
      }
    };
    await expect(
      repository.updateStatus(tx as never, operator.id, 'address', 'unused')
    ).rejects.toThrow('不能恢复');
    expect(tx.idBusinessV2RechargeAddress.update).not.toHaveBeenCalled();
  });

  it('selects only an unused address owned by the operator', async () => {
    const repository = new RechargeAddressRepository({} as never);
    const address = { id: 'address', ownerId: operator.id, status: 'unused' };
    const tx = {
      ...authorizationClient(),
      idBusinessV2RechargeAddress: {
        findFirst: vi.fn().mockResolvedValue(address)
      }
    };
    await expect(repository.requireUnused(tx as never, operator.id, 'address')).resolves.toBe(
      address
    );
    expect(tx.idBusinessV2RechargeAddress.findFirst).toHaveBeenCalledWith({
      where: { id: 'address', ownerId: operator.id, status: 'unused' }
    });
    tx.idBusinessV2RechargeAddress.findFirst.mockResolvedValueOnce(null);
    await expect(
      repository.requireUnused(tx as never, operator.id, 'used-address')
    ).rejects.toThrow('请重新选择');
  });

  it('marks an address used after successful activation and keeps the operation idempotent', async () => {
    const repository = new RechargeAddressRepository({} as never);
    const tx = {
      ...authorizationClient(),
      idBusinessV2RechargeAddress: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ id: 'address', status: 'unused' })
          .mockResolvedValueOnce({ id: 'address', status: 'used' }),
        update: vi.fn().mockResolvedValue({ id: 'address', status: 'used', usedAt: new Date() })
      }
    };
    await expect(repository.markUsed(tx as never, operator.id, 'address')).resolves.toMatchObject({
      changed: true,
      after: { status: 'used' }
    });
    await expect(repository.markUsed(tx as never, operator.id, 'address')).resolves.toMatchObject({
      changed: false,
      after: { status: 'used' }
    });
    expect(tx.idBusinessV2RechargeAddress.update).toHaveBeenCalledOnce();
  });

  it('records one use per recharge job while allowing another job to reuse the address', async () => {
    const repository = new RechargeAddressRepository({} as never);
    const uses = new Map<string, { addressId: string; ownerId: string }>();
    const tx = {
      ...authorizationClient(),
      idBusinessV2RechargeAddress: {
        findFirst: vi.fn().mockResolvedValue({ id: 'address', status: 'used' }),
        update: vi.fn().mockResolvedValue({ id: 'address', status: 'used', usedAt: new Date() })
      },
      idBusinessV2RechargeAddressUse: {
        findUnique: vi.fn(
          async ({ where }: { where: { jobId: string } }) => uses.get(where.jobId) ?? null
        ),
        create: vi.fn(
          async ({ data }: { data: { jobId: string; addressId: string; ownerId: string } }) => {
            uses.set(data.jobId, data);
          }
        )
      }
    };
    await expect(
      repository.markUsed(tx as never, operator.id, 'address', 'job-1')
    ).resolves.toMatchObject({ changed: true });
    await expect(
      repository.markUsed(tx as never, operator.id, 'address', 'job-1')
    ).resolves.toMatchObject({ changed: false });
    await expect(
      repository.markUsed(tx as never, operator.id, 'address', 'job-2')
    ).resolves.toMatchObject({ changed: true });
    expect(tx.idBusinessV2RechargeAddressUse.create).toHaveBeenCalledTimes(2);
    expect(tx.idBusinessV2RechargeAddress.update).toHaveBeenCalledTimes(2);
  });
});
