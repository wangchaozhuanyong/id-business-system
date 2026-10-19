import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSharedCardPlan, sharedCardPlan, sharedCardPlans } from './card-plan-policy';
import { SharedBankCardRepository } from './persistence/shared-bank-card.repository';
import { OnlineRechargeWorkerRepository } from '../online-recharge/persistence/worker.repository';

beforeEach(() => vi.stubEnv('DATABASE_URL', 'postgresql://unit.invalid/only'));
afterEach(() => vi.unstubAllEnvs());

const taskId = '11111111-1111-4111-8111-111111111111';
const plusId = '22222222-2222-4222-8222-222222222222';
const proId = '33333333-3333-4333-8333-333333333333';
type FakeCard = Record<string, unknown> & {
  id: string;
  allowedPlans: string[];
  leaseOwner: string | null;
  successCount: number;
  declineCount: number;
  status: string;
};

function fixture(plan = 'plus', preferred?: string) {
  const cards: FakeCard[] = [
    { id: proId, numberHash: 'pro', allowedPlans: ['pro_20x'], last4: '2222' },
    { id: plusId, numberHash: 'plus', allowedPlans: ['plus'], last4: '1111' }
  ].map((card) => ({
    ...card,
    numberEncrypted: 'encrypted',
    status: 'active',
    successCount: 0,
    declineCount: 0,
    leaseOwner: null as string | null,
    leaseId: null,
    leaseVersion: 0,
    leaseExpiresAt: null,
    expiryMonth: 12,
    expiryYear: 2099,
    holderName: '',
    addressId: null
  }));
  const task = {
    id: taskId,
    status: 'running',
    plan,
    operation: 'recharge',
    leaseOwner: 'worker',
    leaseId: 'lease',
    leaseVersion: 1,
    leaseExpiresAt: new Date(Date.now() + 90000),
    payload: preferred ? { cardId: preferred } : {},
    cardId: null,
    paymentStarted: false
  };
  function matches(card: FakeCard, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (key === 'OR')
        return (value as Record<string, unknown>[]).some((item) => matches(card, item));
      if (key === 'allowedPlans')
        return (value as { array_contains: string[] }).array_contains.every((item) =>
          card.allowedPlans.includes(item)
        );
      if (value && typeof value === 'object') {
        if ('lt' in value) return Number(card[key]) < Number(value.lt);
        if ('notIn' in value) return !(value.notIn as string[]).includes(String(card[key]));
      }
      return card[key] === value;
    });
  }
  const tx = {
    idBusinessV2RechargeJob: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    onlineRechargeCard: {
      findMany: vi.fn(async ({ where }) => cards.filter((card) => matches(card, where))),
      findUnique: vi.fn(async ({ where }) => cards.find((card) => matches(card, where)) ?? null),
      findFirst: vi.fn(async ({ where }) => cards.find((card) => matches(card, where)) ?? null),
      upsert: vi.fn(async ({ where }) => cards.find((card) => matches(card, where))),
      updateMany: vi.fn(async ({ where, data }) => {
        const found = cards.filter((card) => matches(card, where));
        for (const card of found)
          for (const [key, value] of Object.entries(data))
            card[key] =
              value && typeof value === 'object' && 'increment' in value
                ? Number(card[key]) + Number(value.increment)
                : value;
        return { count: found.length };
      })
    },
    idBusinessV2BankRechargeCard: { findUnique: vi.fn().mockResolvedValue(null) },
    onlineRechargeConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    onlineRechargeTask: {
      findUnique: vi.fn(async () => task),
      update: vi.fn(async ({ data }) => Object.assign(task, data))
    }
  };
  const encryption = { decrypt: vi.fn(() => 'synthetic-only') };
  const pool = new SharedBankCardRepository(
    {} as never,
    encryption as never,
    {} as never,
    {} as never
  );
  const repository = { transaction: vi.fn(async (_key, work) => work(tx)), log: vi.fn() };
  const worker = new OnlineRechargeWorkerRepository(
    repository as never,
    { cardPolicy: async () => ({ maxSubscriptionCount: 2, maxDeclineCount: 3 }) } as never,
    encryption as never,
    { available: async (ids: string[]) => ids } as never,
    {} as never
  );
  const rpc = {
    taskId,
    workerId: 'worker',
    leaseId: 'lease',
    leaseVersion: 1,
    method: 'reserveCard'
  };
  return { cards, task, tx, pool, worker, rpc, encryption };
}

describe('共享银行卡套餐限制', () => {
  it('兼容比特套餐命名，但 Plus 不能匹配任何 Pro 档位', () => {
    expect(sharedCardPlan('pro-20x')).toBe('pro_20x');
    expect(() => assertSharedCardPlan(['plus'], 'pro_5x')).toThrow('不允许');
    expect(() => assertSharedCardPlan(['pro_20x'], 'plus')).toThrow('不允许');
    expect(() => sharedCardPlans([])).toThrow('至少选择');
    expect(() => sharedCardPlans(['anything'])).toThrow('无效');
    expect(sharedCardPlans(['plus', 'plus'])).toEqual(['plus']);
  });

  it.each(['plus', 'pro_20x'])('线上智能分配严格按 %s 匹配', async (plan) => {
    const { worker, rpc, cards } = fixture(plan);
    const result = await worker.reserveCard(rpc as never);
    expect(cards.find((card) => card.id === result?.id)?.allowedPlans).toContain(plan);
  });

  it('手选不匹配套餐不降级为其他卡，恢复原卡也不能越过限制', async () => {
    const { worker, rpc, task } = fixture('plus', proId);
    task.cardId = proId as never;
    expect(await worker.reserveCard(rpc as never)).toBeNull();
  });

  it('比特任务持有的卡不能被线上代充分配', async () => {
    const { pool, tx, worker, rpc, cards } = fixture('plus');
    await pool.reserveLegacy(
      tx as never,
      { numberHash: 'plus', numberEncrypted: 'encrypted', expiry: '12/99' } as never,
      'plus',
      'bit-job'
    );
    expect(cards.find((card) => card.id === plusId)?.leaseOwner).toBe('bit-job');
    expect(await worker.reserveCard(rpc as never)).toBeNull();
  });

  it('线上占用卡不能被比特任务取得，也不能用手填卡号绕过套餐', async () => {
    const { pool, tx, worker, rpc } = fixture('plus');
    await worker.reserveCard(rpc as never);
    await expect(
      pool.reserveLegacy(
        tx as never,
        { numberHash: 'plus', numberEncrypted: 'encrypted', expiry: '12/99' } as never,
        'plus',
        'bit-job'
      )
    ).rejects.toThrow('正被');
    await expect(pool.assertNumber(tx as never, 'pro', 'plus')).rejects.toThrow('不允许');
  });

  it('选卡后发生占用竞争时不会交出卡号', async () => {
    const { worker, rpc, tx, encryption } = fixture();
    tx.onlineRechargeCard.updateMany.mockResolvedValue({ count: 0 });
    await expect(worker.reserveCard(rpc as never)).rejects.toThrow('已被占用');
    expect(encryption.decrypt).not.toHaveBeenCalled();
  });

  it('比特未知付款结果保留占用，超时不自行释放', async () => {
    const { pool, tx, cards } = fixture();
    cards[1]!.leaseOwner = 'bit-job';
    await pool.finishBitBrowser(
      tx as never,
      'bit-job',
      { payment_attempted: true, payment_status: 'unknown' },
      false
    );
    expect(cards[1]!.leaseOwner).toBe('bit-job');
    expect(tx.onlineRechargeCard.updateMany).not.toHaveBeenCalled();
  });

  it('成功结果只记一次并达到上限停用，明确未付款可释放', async () => {
    const { pool, tx, cards } = fixture();
    cards[1]!.leaseOwner = 'bit-job';
    cards[1]!.successCount = 1;
    await pool.finishBitBrowser(tx as never, 'bit-job', {}, true);
    await pool.finishBitBrowser(tx as never, 'bit-job', {}, true);
    expect(cards[1]!.successCount).toBe(2);
    expect(cards[1]!.status).toBe('exhausted');
    cards[0]!.leaseOwner = 'other-bit-job';
    await pool.finishBitBrowser(
      tx as never,
      'other-bit-job',
      { payment_attempted: false, payment_requests_sent: 0 },
      false
    );
    expect(cards[0]!.leaseOwner).toBeNull();
  });
});
