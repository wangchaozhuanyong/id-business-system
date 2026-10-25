import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import {
  RechargeBillingRepository,
  billingAddressKey,
  billingJobSettled
} from './persistence/recharge-billing.repository';
const generator = vi.hoisted(() => ({ street: 100, name: 1, collide: false }));
vi.mock('./recharge-billing-generator', () => ({
  generateRechargeBillingAddress: () => ({
    country: 'US',
    line1: `${generator.collide ? 100 : generator.street++} Main St`,
    city: 'Portland',
    state: 'Oregon',
    postalCode: '97201'
  }),
  generateRechargeBillingName: () => `Synthetic Person${generator.name++}`
}));
interface FakeRow {
  id?: string;
  addressId?: string | null;
  nameEncrypted?: string | null;
  nameHash?: string;
  addressHash?: string;
  requestKey?: string;
  jobId?: string | null;
  result?: Record<string, unknown>;
  [key: string]: unknown;
}
type FakeWhere = Record<string, unknown>;
interface Query {
  where?: FakeWhere;
  include?: { address?: boolean };
}
interface Mutation {
  where: FakeWhere;
  data: FakeRow;
}
function fixture() {
  generator.street = 100;
  generator.name = 1;
  generator.collide = false;
  const allocations: FakeRow[] = [],
    addresses: FakeRow[] = [],
    jobs: FakeRow[] = [],
    uses: FakeRow[] = [];
  let sequence = 1;
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const match = (row: FakeRow, where: FakeWhere = {}): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'billingAllocations') {
        const related = allocations.filter((item) => item.addressId === row.id);
        const condition = value as { some?: FakeWhere; none?: FakeWhere };
        return condition.some
          ? related.some((item) => match(item, condition.some))
          : !related.some((item) => match(item, condition.none));
      }
      if (key === 'OR') return (value as FakeWhere[]).some((part) => match(row, part));
      if (key === 'result') return row.result?.addressId === (value as { equals: unknown }).equals;
      if (value && typeof value === 'object') {
        if ('in' in value) return (value.in as unknown[]).includes(row[key]);
        if ('not' in value) return (row[key] ?? null) !== value.not;
      }
      return (row[key] ?? null) === value;
    });
  const result = (row: FakeRow | undefined, include: Query['include']) =>
    row && {
      ...row,
      ...(include?.address
        ? { address: addresses.find((a) => a.id === row.addressId) ?? null }
        : {})
    };
  const allocationModel = {
    findMany: vi.fn(async ({ where }: Query = {}) => allocations.filter((a) => match(a, where))),
    findUnique: vi.fn(
      async ({ where, include }: Query) =>
        result(
          allocations.find((row) => match(row, where)),
          include
        ) ?? null
    ),
    count: vi.fn(async ({ where }: Query) => allocations.filter((row) => match(row, where)).length),
    create: vi.fn(async ({ data, include }: { data: FakeRow; include?: Query['include'] }) => {
      for (const key of ['requestKey', 'nameHash', 'addressHash', 'jobId'])
        if (data[key] && allocations.some((a) => a[key] === data[key]))
          throw new Error('duplicate fingerprint');
      const row = { id: `allocation-${sequence++}`, ...data };
      allocations.push(row);
      return result(row, include);
    }),
    createMany: vi.fn(async ({ data }: { data: FakeRow[] }) => {
      let count = 0;
      for (const row of data) {
        if (
          allocations.some((a) =>
            ['nameHash', 'addressHash'].some((key) => row[key] && row[key] === a[key])
          )
        )
          continue;
        allocations.push({ id: `seed-${sequence++}`, ...row });
        count++;
      }
      return { count };
    }),
    update: vi.fn(async ({ where, data }: Mutation) => {
      const row = allocations.find((a) => match(a, where));
      if (!row) throw new Error('missing fixture allocation');
      Object.assign(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: Mutation) => {
      const rows = allocations.filter((a) => match(a, where));
      rows.forEach((a) => Object.assign(a, data));
      return { count: rows.length };
    })
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ locked: 1 }]),
    $executeRaw: vi.fn(),
    securitySetting: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ status: 'active', deletedAt: null })) },
    idBusinessV2RechargeBillingAllocation: allocationModel,
    idBusinessV2RechargeName: { findMany: vi.fn(async () => [] as FakeRow[]), update: vi.fn() },
    idBusinessV2RechargeCardName: { findMany: vi.fn(async () => [] as FakeRow[]) },
    idBusinessV2BankRechargeCard: { findMany: vi.fn(async () => [] as FakeRow[]) },
    idBusinessV2RechargeAddressUse: {
      findMany: vi.fn(async ({ where }: Query) => uses.filter((u) => match(u, where))),
      updateMany: vi.fn(async () => ({ count: 0 }))
    },
    idBusinessV2RechargeJob: {
      findMany: vi.fn(async ({ where }: Query) => jobs.filter((job) => match(job, where)))
    },
    idBusinessV2RechargeAddress: {
      findMany: vi.fn(async ({ where }: Query = {}) => addresses.filter((a) => match(a, where))),
      findFirst: vi.fn(async ({ where }: Query) => addresses.find((a) => match(a, where)) ?? null),
      create: vi.fn(async ({ data }: { data: FakeRow }) => {
        const row = { id: `address-${sequence++}`, createdAt: new Date(), ...data };
        addresses.push(row);
        return row;
      }),
      delete: vi.fn(async ({ where }: { where: FakeWhere }) => {
        const index = addresses.findIndex((a) => a.id === where.id);
        const [row] = addresses.splice(index, 1);
        allocations.filter((a) => a.addressId === row.id).forEach((a) => (a.addressId = null));
        return row;
      })
    }
  };
  const repository = new RechargeBillingRepository({
    hash,
    encrypt: (v: string) => v,
    decrypt: (v: string) => v
  } as never);
  const allocate = (key: string, extra: { addressId?: string; numberHash?: string } = {}) =>
    repository.allocate(tx as never, { key, numberHash: 'card-hash', ownerId: 'owner', ...extra });
  return { repository, tx, addresses, allocations, jobs, uses, allocate };
}
describe('每笔账单唯一分配与地址安全清理', () => {
  it('空池补充恰好100条；同草稿幂等，新充值永不复用姓名和地址', async () => {
    const f = fixture();
    const first = await f.allocate('draft-1');
    expect(first.generated).toBe(100);
    expect(f.addresses).toHaveLength(100);
    const same = await f.allocate('draft-1');
    expect(same.allocation.id).toBe(first.allocation.id);
    expect(same.generated).toBe(0);
    const next = await f.allocate('draft-2');
    expect(next.allocation.nameHash).not.toBe(first.allocation.nameHash);
    expect(next.allocation.addressHash).not.toBe(first.allocation.addressHash);
    expect(f.tx.idBusinessV2RechargeAddress.create).toHaveBeenCalledTimes(100);
  });
  it('地址被另一草稿分配后拒绝手工指定；任务绑定后不能换任务或改姓名', async () => {
    const f = fixture();
    const first = await f.allocate('draft-1');
    await expect(f.allocate('draft-2', { addressId: first.allocation.addressId! })).rejects.toThrow(
      '已分配'
    );
    const id = first.allocation.id;
    const input = {
      ownerId: 'owner',
      numberHash: 'card-hash',
      name: first.allocation.nameEncrypted!,
      addressId: first.allocation.addressId!,
      jobId: 'job-1'
    };
    await expect(f.repository.verify(f.tx as never, id, input)).resolves.toMatchObject({
      jobId: 'job-1'
    });
    await expect(
      f.repository.verify(f.tx as never, id, { ...input, jobId: 'job-2' })
    ).rejects.toThrow('已变化');
    await expect(
      f.repository.verify(f.tx as never, id, { ...input, name: 'Changed Person' })
    ).rejects.toThrow('已变化');
    await expect(f.allocate('draft-1')).rejects.toThrow('已使用');
  });
  it('耗尽时删除已结束任务的地址，保护未知任务；删除后指纹仍挡住旧生成结果', async () => {
    const f = fixture();
    f.addresses.push(
      {
        id: 'old',
        ownerId: 'owner',
        country: 'US',
        line1: '100 Main St',
        line2: null,
        city: 'Portland',
        state: 'OR',
        postalCode: '97201',
        status: 'used'
      },
      {
        id: 'unknown',
        ownerId: 'owner',
        country: 'US',
        line1: '999 Main St',
        line2: null,
        city: 'Portland',
        state: 'OR',
        postalCode: '97201',
        status: 'used'
      }
    );
    f.jobs.push(
      {
        id: 'old-job',
        state: 'finished',
        result: { addressId: 'old', status: 'subscription_activated', payment_status: 'paid' }
      },
      {
        id: 'unknown-job',
        state: 'unknown',
        result: { addressId: 'unknown', payment_status: 'unknown' }
      }
    );
    const result = await f.allocate('draft-new');
    expect(result.generated).toBe(100);
    expect(result.removed).toBe(1);
    expect(f.addresses.some((a) => a.id === 'old')).toBe(false);
    expect(f.addresses.some((a) => a.id === 'unknown')).toBe(true);
    expect(f.addresses.some((a) => a.line1 === '100 Main St')).toBe(false);
    expect(
      await f.repository.isHistoricalAddress(f.tx as never, {
        country: 'US',
        line1: '100 Main St',
        line2: null,
        city: 'Portland',
        state: 'Oregon',
        postalCode: '97201'
      })
    ).toBe(true);
  });
  it('手工标记已用也永久保留地址指纹，删除后的迟到回调不重建地址', async () => {
    const f = fixture();
    const address = {
      country: 'US',
      line1: '100 Main St',
      line2: null,
      city: 'Portland',
      state: 'OR',
      postalCode: '97201'
    };
    await f.repository.rememberUsedAddress(f.tx as never, address, 'owner');
    expect(await f.repository.isHistoricalAddress(f.tx as never, address)).toBe(true);
    const repository = new RechargeAddressRepository({} as never);
    const tx = {
      idBusinessV2RechargeAddressUse: {
        findUnique: vi.fn(async () => ({
          addressId: null,
          addressReference: 'removed-address',
          ownerId: 'owner'
        }))
      },
      idBusinessV2RechargeAddress: { findFirst: vi.fn() }
    };
    await expect(
      repository.markUsed(tx as never, 'owner', 'removed-address', 'old-job')
    ).resolves.toMatchObject({ changed: false });
    expect(tx.idBusinessV2RechargeAddress.findFirst).not.toHaveBeenCalled();
  });
  it('运行中任务仅通过分配记录引用地址时也禁止清理', async () => {
    const f = fixture();
    const first = await f.allocate('draft');
    f.allocations.find((a) => a.id === first.allocation.id)!.jobId = 'active-job';
    f.jobs.push({ id: 'active-job', state: 'running', result: {} });
    f.addresses.forEach((a) => {
      a.status = 'used';
    });
    await f.allocate('new-draft');
    expect(f.addresses.some((a) => a.id === first.allocation.addressId)).toBe(true);
  });
  it('已结束但付款仍未知或带有矛盾已付款证据时禁止清理', () => {
    expect(
      billingJobSettled({
        state: 'finished',
        result: { payment_status: 'unknown', payment_attempted: false, payment_requests_sent: 0 }
      })
    ).toBe(false);
    expect(
      billingJobSettled({
        state: 'finished',
        result: { status: 'subscription_activated', payment_status: 'unknown' }
      })
    ).toBe(false);
    expect(
      billingJobSettled({
        state: 'finished',
        result: { payment_status: 'paid', payment_attempted: false, payment_requests_sent: 0 }
      })
    ).toBe(false);
  });
  it('历史姓名指纹纳入排重，生成冲突会重试，不能循环复用', async () => {
    const f = fixture();
    f.tx.idBusinessV2RechargeCardName.findMany.mockResolvedValueOnce([
      { nameEncrypted: 'Synthetic Person1' }
    ]);
    const result = await f.allocate('draft');
    expect(result.allocation.nameEncrypted).toBe('Synthetic Person2');
  });
  it('指纹规范化州缩写、大小写和空白；未知和执行中任务永远不算可清理', () => {
    expect(
      billingAddressKey({
        country: 'US',
        line1: '100  Main St',
        line2: '',
        city: 'Portland',
        state: 'OR',
        postalCode: '97201'
      })
    ).toBe(
      billingAddressKey({
        country: 'us',
        line1: '100 Main St',
        line2: null,
        city: 'portland',
        state: 'Oregon',
        postalCode: '97201'
      })
    );
    expect(
      billingJobSettled({
        state: 'unknown',
        result: { payment_attempted: false, payment_requests_sent: 0 }
      })
    ).toBe(false);
    expect(billingJobSettled({ state: 'finished', result: { payment_status: 'unknown' } })).toBe(
      false
    );
    expect(billingJobSettled({ state: 'finished', result: { payment_status: 'declined' } })).toBe(
      true
    );
  });
});
