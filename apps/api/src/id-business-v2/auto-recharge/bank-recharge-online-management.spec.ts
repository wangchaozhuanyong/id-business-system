import { describe, expect, it, vi } from 'vitest';
import { BankRechargeOrderService } from './bank-recharge-order.service';
import { BankRechargeQueryRepository } from './persistence/bank-recharge-query.repository';
import { assertBankRechargeChannelAccess, bankRechargeOrderChannel } from './bank-recharge-channel';

const id = '11111111-1111-4111-8111-111111111111';
const updatedAt = new Date('2026-10-15T10:00:00.000Z');
const operator = {
  id,
  roles: ['admin'],
  permissions: ['id_business_v2.online_recharge.read', 'id_business_v2.online_recharge.manage']
};
function fixture() {
  const previous = {
    id,
    channel: 'online',
    source: 'automatic',
    status: 'pending_details',
    accountingVersion: 'subscription_cost_v2',
    chargeAmount: null,
    chargeCurrencyCode: null,
    customerFeeRate: '0',
    customerFeeAmount: '0',
    customerFeeOverridden: false,
    accountId: null,
    customerId: null,
    cardId: null,
    onlineRechargeCardId: null,
    plan: 'pro-500',
    openedAt: null,
    dueAt: null,
    updatedAt,
    chargeFxRateToCny: null,
    bankFeeFxRateToCny: null,
    receivedFxRateToCny: null,
    onlineSourceSnapshot: { accountKey: 'a'.repeat(64) },
    manualEvidenceRef: null,
    cardLast4: null
  };
  const repository = {
    findOrder: vi.fn().mockResolvedValue(previous),
    createOrder: vi.fn(async (_tx, { data }) => ({ id, ...data })),
    updateOrder: vi.fn(async (_tx, { data }) => ({ ...previous, ...data })),
    findOtherOrderByPaymentReference: vi.fn().mockResolvedValue(null),
    findCard: vi.fn(),
    findOnlineCard: vi.fn().mockResolvedValue({ id, last4: '1234', status: 'active' }),
    findRechargeJob: vi.fn()
  };
  const audit = { append: vi.fn() };
  const accounts = {
    requireCurrency: vi.fn().mockResolvedValue({ minorUnits: 2 }),
    requireActive: vi.fn()
  };
  const service = new BankRechargeOrderService(
    { execute: vi.fn(async (work) => work({}, {})) } as never,
    audit as never,
    accounts as never,
    repository as never,
    { prepare: vi.fn().mockResolvedValue({}) } as never,
    { decrypt: vi.fn().mockReturnValue(null) } as never
  );
  const update = (input: Record<string, unknown>, user = operator) =>
    service.update(id, { expectedUpdatedAt: updatedAt.toISOString(), ...input }, user as never);
  return { previous, service, repository, accounts, audit, update };
}
describe('线上订单补全与渠道权限', () => {
  it('缺金额币种凭人工付款编号补核；保留日期为空且不激活账号订阅', async () => {
    const f = fixture();
    const result = await f.update({
      chargeAmount: '123.45',
      chargeCurrencyCode: 'PHP',
      paymentEvidenceRef: 'receipt_fixture'
    });
    expect(result).toMatchObject({
      chargeAmount: '123.45',
      chargeCurrencyCode: 'PHP',
      openedAt: null,
      dueAt: null,
      manualEvidenceRef: 'receipt_fixture',
      onlineSourceSnapshot: expect.objectContaining({ manualAmountEvidenceRef: 'receipt_fixture' })
    });
    expect(f.repository.findRechargeJob).not.toHaveBeenCalled();
  });
  it('缺金额时不提供凭据不可补核', async () => {
    const f = fixture();
    await expect(f.update({ chargeAmount: '123.45', chargeCurrencyCode: 'PHP' })).rejects.toThrow(
      '核验凭据编号'
    );
    expect(f.repository.updateOrder).not.toHaveBeenCalled();
  });
  it('已知金额不可改写，但可单独补核缺失的付款编号', async () => {
    const f = fixture();
    Object.assign(f.previous, { chargeAmount: '123.45', chargeCurrencyCode: 'PHP' });
    await expect(f.update({ chargeAmount: '999', paymentEvidenceRef: 'new' })).rejects.toThrow(
      '官网代付事实不能修改'
    );
    const result = await f.update({ paymentEvidenceRef: 'receipt_fixture' });
    expect(result).toMatchObject({ chargeAmount: '123.45', manualEvidenceRef: 'receipt_fixture' });
  });
  it('已知金额仅补齐同值小数格式不算改写，也不要求新付款凭据', async () => {
    const f = fixture();
    Object.assign(f.previous, { chargeAmount: '123.4', chargeCurrencyCode: 'PHP' });
    await expect(f.update({ chargeAmount: '123.40' })).resolves.toMatchObject({
      chargeAmount: '123.4',
      manualEvidenceRef: null
    });
    expect(f.repository.findOtherOrderByPaymentReference).not.toHaveBeenCalled();
  });
  it('线上手工订单缺金额和日期时保留待核对，不以当前时间或零元填充', async () => {
    const f = fixture();
    await expect(
      f.service.createManual(
        { channel: 'online', plan: 'pro-500', manualEvidenceRef: 'manual_receipt' },
        operator as never
      )
    ).resolves.toMatchObject({
      channel: 'online',
      source: 'manual',
      chargeAmount: null,
      chargeCurrencyCode: null,
      openedAt: null,
      dueAt: null
    });
  });
  it.each([0, false])('线上手工非法金额 %j 不会被当成留空', async (chargeAmount) => {
    const f = fixture();
    await expect(
      f.service.createManual(
        {
          channel: 'online',
          plan: 'pro-500',
          chargeAmount,
          chargeCurrencyCode: 'PHP',
          manualEvidenceRef: 'manual_receipt'
        },
        operator as never
      )
    ).rejects.toThrow('代付金额');
    expect(f.repository.createOrder).not.toHaveBeenCalled();
  });
  it.each(['https://example.invalid/private', 'session=fixture-private-value'])(
    '线上手工凭据拒绝网址或登录资料 %s',
    async (manualEvidenceRef) => {
      const f = fixture();
      await expect(
        f.service.createManual(
          { channel: 'online', plan: 'pro-500', manualEvidenceRef },
          operator as never
        )
      ).rejects.toThrow('只填写付款凭据编号');
      expect(f.repository.createOrder).not.toHaveBeenCalled();
    }
  );
  it('保留未知金额不会静默改为0或默认美元，仍可补普通备注', async () => {
    const result = await fixture().update({ remark: '等待核实' });
    expect(result).toMatchObject({ chargeAmount: null, chargeCurrencyCode: null });
  });
  it('线上卡使用独立来源，拒绝把线上卡号写入比特外键', async () => {
    const f = fixture();
    await expect(f.update({ cardId: id })).rejects.toThrow('当前订单渠道');
    const result = await f.update({
      onlineRechargeCardId: id,
      paymentEvidenceRef: 'card_receipt_fixture'
    });
    expect(result).toMatchObject({ cardId: null, onlineRechargeCardId: id, cardLast4: '1234' });
    expect(f.repository.findCard).not.toHaveBeenCalled();
  });
  it('原卡已耗尽仍可补原单，但不允许用同尾号其它卡替换', async () => {
    const f = fixture();
    Object.assign(f.previous, {
      onlineRechargeCardId: id,
      cardLast4: '1234',
      onlineSourceSnapshot: { accountKey: 'a'.repeat(64), originalCardId: id }
    });
    f.repository.findOnlineCard.mockResolvedValue({ id, last4: '1234', status: 'exhausted' });
    await expect(f.update({ remark: '只补原单资料' })).resolves.toMatchObject({
      onlineRechargeCardId: id
    });
    await expect(
      f.update({
        onlineRechargeCardId: '22222222-2222-4222-8222-222222222222',
        paymentEvidenceRef: 'different_card'
      })
    ).rejects.toThrow('即使尾号相同');
  });
  it('重复或网址凭据被拒绝，不留下资料变更', async () => {
    const f = fixture();
    await expect(
      f.update({ paymentEvidenceRef: 'https://example.invalid/private' })
    ).rejects.toThrow('只填写付款凭据编号');
    f.repository.findOtherOrderByPaymentReference.mockResolvedValue({ id: 'other' } as never);
    await expect(f.update({ paymentEvidenceRef: 'receipt_fixture' })).rejects.toThrow(
      '关联其他充值订单'
    );
    expect(f.repository.updateOrder).not.toHaveBeenCalled();
  });
  it('管理员仍需线上管理权限，比特旧调用保持兼容', async () => {
    expect(bankRechargeOrderChannel()).toBe('bitbrowser');
    expect(() => assertBankRechargeChannelAccess('bitbrowser')).not.toThrow();
    expect(() =>
      assertBankRechargeChannelAccess('online', { ...operator, permissions: [] } as never)
    ).toThrow('线上订单读取');
    const f = fixture();
    await expect(
      f.update(
        { remark: 'x' },
        { ...operator, permissions: ['id_business_v2.online_recharge.read'] }
      )
    ).rejects.toThrow('线上订单管理');
    expect(f.repository.updateOrder).not.toHaveBeenCalled();
  });
  it('线上查询去除比特来源条件，返回独立卡安全投影', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id,
        channel: 'online',
        source: 'automatic',
        onlineRechargeCard: { id, last4: '1234', status: 'active' },
        onlineSourceSnapshot: { chargeCountryCode: 'MY' },
        card: null,
        rechargeJob: null
      }
    ]);
    const count = vi.fn().mockResolvedValue(1);
    const service = new BankRechargeQueryRepository({
      idBusinessV2BankRechargeOrder: { findMany, count }
    } as never);
    const response = await service.list(
      { channel: 'online', deleted: 'deleted' },
      operator as never
    );
    expect(findMany.mock.calls[0]![0].where).toMatchObject({
      channel: 'online',
      deletedAt: { not: null }
    });
    expect(findMany.mock.calls[0]![0].where).not.toHaveProperty('rechargeJob');
    expect(response.items[0]).toMatchObject({
      card: { id, last4: '1234', active: true },
      chargeCountryCode: 'MY'
    });
    await expect(
      service.list({ channel: 'online', executionSource: 'bitbrowser' }, operator as never)
    ).rejects.toThrow('执行来源');
  });
});
