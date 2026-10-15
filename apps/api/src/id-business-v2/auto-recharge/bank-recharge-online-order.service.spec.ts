import { describe, expect, it, vi } from 'vitest';
import {
  BankRechargeOnlineOrderService,
  type VerifiedOnlineRechargeOrderFact
} from './bank-recharge-online-order.service';
import { BankRechargeOnlineOrderRepository } from './persistence/bank-recharge-online-order.repository';

const taskId = '11111111-1111-4111-8111-111111111111';
const cardId = '22222222-2222-4222-8222-222222222222';
const actorUserId = '33333333-3333-4333-8333-333333333333';
const accountKey = 'a'.repeat(64);
const fact: VerifiedOnlineRechargeOrderFact = {
  taskId,
  actorUserId,
  provider: 'local',
  plan: 'pro_500',
  accountKey,
  emailEncrypted: 'fixture-encrypted-email',
  cardId,
  cardLabel: null,
  cardLast4: '1234',
  chargeAmount: '5484.73',
  chargeCurrencyCode: 'PHP',
  chargeCountryCode: 'PH',
  paymentReference: 'pi_fixture',
  checkoutIdentifier: 'cs_fixture',
  zeroAmountChange: false,
  paymentKind: 'upgrade',
  verifiedAt: '2026-10-15T10:00:00.000Z',
  openedAt: null,
  dueAt: null
};
function fixture() {
  const stored: Record<string, unknown>[] = [];
  const repository = {
    createOrder: vi.fn(async (_tx, args) => {
      const value = { id: 'order-1', ...args.data };
      stored.push(value);
      return value;
    }),
    findAccountByOfficialKey: vi.fn().mockResolvedValue(null),
    findAccountByEmailHash: vi.fn().mockResolvedValue(null),
    createAccount: vi.fn(async (_tx, args) => ({ id: 'account-1', ...args.data })),
    updateAccount: vi.fn()
  };
  const online = {
    findExisting: vi.fn(async (_tx, id) =>
      stored.filter((order) => order.onlineRechargeTaskId === id)
    ),
    findCard: vi.fn().mockResolvedValue({ id: cardId, last4: '1234', status: 'active' })
  };
  const audit = { append: vi.fn() };
  const encryption = {
    decrypt: vi.fn().mockReturnValue('fixture@example.com'),
    encrypt: vi.fn().mockReturnValue('new-encrypted-email'),
    hash: vi.fn().mockReturnValue('email-hash')
  };
  const service = new BankRechargeOnlineOrderService(
    repository as never,
    online as never,
    encryption as never,
    audit as never
  );
  return { service, repository, online, audit, stored, encryption };
}
describe('线上成功原单同步到充值订单', () => {
  it.each(['local', 'third_party'])(
    '%s 原单只建待补全订单，独立卡关联且不复制敏感凭据',
    async (provider) => {
      const f = fixture();
      await f.service.syncInTransaction({} as never, { ...fact, provider });
      expect(f.stored[0]).toMatchObject({
        channel: 'online',
        source: 'automatic',
        onlineRechargeTaskId: taskId,
        onlineRechargeCardId: cardId,
        cardId: null,
        plan: 'pro-500',
        chargeAmount: '5484.73',
        chargeCurrencyCode: 'PHP',
        status: 'pending_details',
        financeStatus: 'unposted',
        openedAt: null,
        dueAt: null
      });
      const saved = JSON.stringify(f.stored);
      expect(saved).not.toMatch(
        /fixture-encrypted-email|new-encrypted-email|fixture@example.com|password|session|securityCode/
      );
      expect(f.repository.createAccount).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          data: expect.not.objectContaining({ passwordEncrypted: expect.anything() })
        })
      );
    }
  );
  it('同原任务复查或回收站重放复用原单，不新建、不激活订阅或入账', async () => {
    const f = fixture();
    const first = await f.service.syncInTransaction({} as never, fact);
    f.stored[0]!.deletedAt = new Date();
    const replay = await f.service.syncInTransaction({} as never, fact);
    expect(replay.id).toBe(first.id);
    expect(f.repository.createOrder).toHaveBeenCalledTimes(1);
  });
  it('其它原任务或比特订单占用同付款证据时转人工核对', async () => {
    const f = fixture();
    f.online.findExisting.mockResolvedValue([
      { id: 'other', channel: 'bitbrowser', paymentEvidenceId: 'pi_fixture' }
    ] as never);
    await expect(f.service.syncInTransaction({} as never, fact)).rejects.toThrow('付款凭据已关联');
    expect(f.repository.createOrder).not.toHaveBeenCalled();
  });
  it('缺失金额、币种、国家和日期保留null，不套用标价或核验时刻', async () => {
    const f = fixture();
    await f.service.syncInTransaction({} as never, {
      ...fact,
      chargeAmount: null,
      chargeCurrencyCode: null,
      chargeCountryCode: null
    });
    expect(f.stored[0]).toMatchObject({
      chargeAmount: null,
      chargeCurrencyCode: null,
      openedAt: null,
      dueAt: null,
      onlineSourceSnapshot: expect.objectContaining({ chargeCountryCode: null })
    });
  });
  it('明确零元升级保留零元类型，不伪造扣款或收款', async () => {
    const f = fixture();
    await f.service.syncInTransaction({} as never, {
      ...fact,
      chargeAmount: '0',
      zeroAmountChange: true
    });
    expect(f.stored[0]).toMatchObject({
      chargeAmount: '0',
      onlineSourceSnapshot: expect.objectContaining({ zeroAmountChange: true }),
      status: 'pending_details'
    });
    expect(f.stored[0]).not.toHaveProperty('receivedAmount');
  });
  it.each([
    { chargeAmount: '0' },
    { chargeAmount: '2', zeroAmountChange: true },
    { chargeAmount: '0', zeroAmountChange: true, paymentKind: 'initial' },
    { accountKey: taskId },
    { chargeCurrencyCode: 'PHP-secret' },
    { cardLast4: '1234567890123456' }
  ])('拒绝错误或不一致事实 %j', async (patch) => {
    const f = fixture();
    await expect(
      f.service.syncInTransaction(
        {} as never,
        { ...fact, ...patch } as VerifiedOnlineRechargeOrderFact
      )
    ).rejects.toThrow();
    expect(f.repository.createOrder).not.toHaveBeenCalled();
  });
  it('与原比特官网指纹及邮箱一致时复用账号，不新建或覆盖凭据', async () => {
    const f = fixture();
    const account = {
      id: 'bit-account',
      officialAccountKey: accountKey,
      status: 'active',
      deletedAt: null
    };
    f.repository.findAccountByOfficialKey.mockResolvedValue(account as never);
    f.repository.findAccountByEmailHash.mockResolvedValue(account as never);
    await f.service.syncInTransaction({} as never, fact);
    expect(f.stored[0]!.accountId).toBe('bit-account');
    expect(f.repository.createAccount).not.toHaveBeenCalled();
    expect(f.repository.updateAccount).not.toHaveBeenCalled();
  });
  it('邮箱/官网身份冲突时不覆盖账号，仍保留待核对订单', async () => {
    const f = fixture();
    f.repository.findAccountByOfficialKey.mockResolvedValue({
      id: 'identity-account',
      status: 'active'
    } as never);
    f.repository.findAccountByEmailHash.mockResolvedValue({
      id: 'email-account',
      officialAccountKey: 'b'.repeat(64)
    } as never);
    await f.service.syncInTransaction({} as never, fact);
    expect(f.stored[0]!.accountId).toBeNull();
    expect(f.repository.createAccount).not.toHaveBeenCalled();
    expect(f.repository.updateAccount).not.toHaveBeenCalled();
  });
  it('查询去重不排除回收站并跨两渠道检查付款凭据', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await new BankRechargeOnlineOrderRepository().findExisting(
      {
        idBusinessV2BankRechargeOrder: { findMany },
        $queryRaw: vi.fn(),
        $executeRaw: vi.fn()
      } as never,
      taskId,
      'pi_fixture',
      'cs_fixture'
    );
    const where = findMany.mock.calls[0]![0].where;
    expect(where).not.toHaveProperty('deletedAt');
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { onlineRechargeTaskId: taskId },
        { paymentEvidenceId: 'pi_fixture' },
        { manualEvidenceRef: 'pi_fixture' },
        { checkoutIdentifier: 'cs_fixture' }
      ])
    );
  });
});
