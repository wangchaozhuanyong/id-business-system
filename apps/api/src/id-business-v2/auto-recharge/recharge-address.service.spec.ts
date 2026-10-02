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
