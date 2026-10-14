import { effectScope, nextTick, ref } from 'vue';
import { describe, it, expect, vi } from 'vitest';
import { useRechargeNameMatch } from './useRechargeNameMatch';
import type { V2RechargeDetails } from './contracts';
const mock = vi.hoisted(() => ({ match: vi.fn() }));
vi.mock('./bank-recharge-api', () => ({ bankRechargeApi: { matchCardName: mock.match } }));
function setup(initial: Partial<V2RechargeDetails> = {}) {
  const scope = effectScope();
  const details = ref<V2RechargeDetails>({
    number: '',
    name: '',
    expiry: '',
    cvc: '',
    email: '',
    country: '',
    line1: '',
    line2: '',
    city: '',
    state: '',
    postal_code: '',
    ...initial
  });
  const selected = ref(''),
    onAddress = vi.fn();
  const matcher = scope.run(() => useRechargeNameMatch(details, selected, ref(false), onAddress))!;
  return { scope, details, selected, matcher };
}
describe('输入银行卡自动匹配姓名', () => {
  it('切页恢复时保留手动账单姓名，换卡后仍自动匹配新姓名', async () => {
    mock.match.mockReset().mockResolvedValue({
      name: 'Pool Person',
      confirmed: false,
      cardId: null,
      billingAddressId: null
    });
    const { scope, details, matcher } = setup({
      number: '5555555555554444',
      name: 'Restored Billing Person'
    });
    await matcher.ensureReady();
    expect(details.value.name).toBe('Restored Billing Person');
    expect(matcher.confirmed.value).toBe(false);
    details.value.number = '4111111111111111';
    await matcher.ensureReady();
    expect(details.value.name).toBe('Pool Person');
    scope.stop();
  });
  it('切页恢复时已确认的历史绑定仍回填并锁定姓名', async () => {
    mock.match.mockReset().mockResolvedValue({
      name: 'Historic Person',
      confirmed: true,
      cardId: 'card-id',
      billingAddressId: null
    });
    const { scope, details, matcher } = setup({
      number: '5555555555554444',
      name: 'Restored Billing Person'
    });
    await matcher.ensureReady();
    expect(details.value.name).toBe('Historic Person');
    expect(matcher.confirmed.value).toBe(true);
    scope.stop();
  });
  it('填写完整卡号后回填历史姓名，不完整或非法卡号不查询', async () => {
    mock.match.mockReset().mockResolvedValue({
      name: 'Existing Person',
      confirmed: true,
      cardId: 'card-id',
      billingAddressId: null
    });
    const { scope, details, selected, matcher } = setup();
    details.value.number = '5555';
    await nextTick();
    expect(mock.match).not.toHaveBeenCalled();
    details.value.number = '5555555555554444';
    await matcher.ensureReady();
    expect(details.value.name).toBe('Existing Person');
    expect(selected.value).toBe('card-id');
    expect(matcher.confirmed.value).toBe(true);
    scope.stop();
  });
  it('快速换卡时旧请求不能覆盖新卡姓名；同尾号也按完整号码查询', async () => {
    let finishOld!: (value: unknown) => void;
    mock.match
      .mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => (finishOld = resolve)))
      .mockResolvedValueOnce({
        name: 'New Person',
        confirmed: false,
        cardId: null,
        billingAddressId: null
      });
    const { scope, details, matcher } = setup();
    details.value.number = '5555555555554444';
    details.value.number = '4111111111111111';
    await matcher.ensureReady();
    finishOld({ name: 'Old Person', confirmed: true, cardId: 'old', billingAddressId: null });
    await nextTick();
    expect(details.value.name).toBe('New Person');
    expect(mock.match.mock.calls.map((call) => call[0])).toEqual([
      '5555555555554444',
      '4111111111111111'
    ]);
    scope.stop();
  });
  it('失败允许重试，迟到的新卡匹配不清除用户后续编辑', async () => {
    mock.match.mockReset().mockRejectedValueOnce(new Error('匹配暂时失败'));
    const { scope, details, matcher } = setup();
    details.value.number = '5555555555554444';
    await expect(matcher.ensureReady()).rejects.toThrow('匹配暂时失败');
    let finish!: (value: unknown) => void;
    mock.match.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const request = matcher.retry();
    details.value.name = 'Manually Confirmed';
    finish({ name: 'Pool Person', confirmed: false, cardId: null, billingAddressId: null });
    await request;
    expect(details.value.name).toBe('Manually Confirmed');
    expect(matcher.error.value).toBe('');
    await matcher.ensureReady();
    expect(details.value.name).toBe('Manually Confirmed');
    expect(mock.match).toHaveBeenCalledTimes(2);
    scope.stop();
  });
});
