import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeV2RechargeConnectorUrl } from '@apple-business/shared';
import { RechargeService } from './recharge.service';
import { RechargeLocalService } from './recharge-local.service';
import { hash, safeDocument } from './recharge-validation';

const id = '11111111-1111-4111-8111-111111111111';
const operator = { id: 'synthetic-owner', roles: ['admin'], permissions: [] };
const agentToken = 'a'.repeat(64);
const nonce = 'b'.repeat(64);
const money = { amount: '20.00', amount_minor: 2000, currency: 'USD' };
const quote = {
  plan: 'plus',
  today: money,
  tax: { ...money, amount: '0.00', amount_minor: 0 },
  renewal: money,
  renewal_interval: 'monthly'
};
const result = () => ({
  status: 'awaiting_confirmation',
  stage: 'awaiting_confirmation',
  account_matched: true,
  target_plan: 'plus',
  current_plan_before: 'free',
  quote,
  quote_authority: 'official_checkout_response',
  quote_digest: 'c'.repeat(64),
  confirmation_expires_at: new Date(Date.now() + 300000).toISOString(),
  nonce,
  payment_attempted: false,
  payment_requests_sent: 0
});
function harness() {
  const job = {
    id,
    ownerId: operator.id,
    action: 'bitbrowser',
    state: 'running',
    plan: 'plus',
    accountKey: 'd'.repeat(64),
    nonceHash: hash(agentToken),
    leaseUntil: new Date(Date.now() + 600000),
    result: { locked_currency: 'USD', manual_payment_confirmation: true }
  };
  const repository = {
    lock: vi.fn(),
    active: vi.fn(async () => job),
    byId: vi.fn(async () => job),
    updateJob: vi.fn(async (_tx, _id, data) => Object.assign(job, data))
  };
  const audit = { append: vi.fn() };
  const transactions = { execute: vi.fn(async (work) => work({})) };
  const service = new RechargeService(
    repository as never,
    { markUsed: vi.fn() } as never,
    transactions as never,
    audit as never
  );
  const local = new RechargeLocalService(
    repository as never,
    {} as never,
    {} as never,
    service,
    transactions as never,
    audit as never
  );
  return { job, repository, audit, service, local };
}
afterEach(() => vi.unstubAllGlobals());
describe('本机人工确认与 API 记录的权限边界', () => {
  it('保存官网报价等待状态而不保存nonce，也不替换本机回传授权', async () => {
    const { local, job, service, repository, audit } = harness();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await local.callback(id, agentToken, { type: 'progress', result: result() });
    expect(job.state).toBe('awaiting_confirmation');
    expect(job.nonceHash).toBe(hash(agentToken));
    expect(job.result).toMatchObject({
      quote_digest: 'c'.repeat(64),
      manual_payment_confirmation: true
    });
    expect(job.result).not.toHaveProperty('nonce');
    expect(JSON.stringify(repository.updateJob.mock.calls)).not.toContain(nonce);
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain(nonce);
    await expect(local.callback(id, nonce, { type: 'progress', result: {} })).rejects.toThrow(
      '连接凭据无效'
    );
    await expect(service.confirm(id, agentToken, operator as never)).rejects.toThrow(
      '本机充值助手'
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { account_matched: false },
    { quote_digest: 'invalid' },
    { quote_digest: undefined },
    { quote: { ...quote, today: { ...money, currency: 'PHP' } } },
    { quote: { ...quote, today: { ...money, amount: '0.00', amount_minor: 0 } } },
    { quote: { ...quote, tax: null } },
    { quote: { ...quote, renewal: null } },
    { confirmation_expires_at: new Date(0).toISOString() },
    { confirmation_expires_at: 'invalid' },
    { confirmation_expires_at: new Date(Date.now() + 11 * 60000).toISOString() }
  ])('身份、完整报价绑定或时间不足时不能进入等待付款确认 %j', async (patch) => {
    const { local, job, repository } = harness();
    await expect(
      local.callback(id, agentToken, { type: 'progress', result: { ...result(), ...patch } })
    ).rejects.toThrow();
    expect(job.state).toBe('running');
    expect(job.nonceHash).toBe(hash(agentToken));
    expect(repository.updateJob).not.toHaveBeenCalled();
  });

  it('超过旧金额上限的完整报价仍仅等待人工确认，不触发付款', async () => {
    const { local, job, audit } = harness();
    Object.assign(job.result, { max_amount_minor: 3000, max_amount: '30.00' });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await local.callback(id, agentToken, {
      type: 'progress',
      result: {
        ...result(),
        quote: { ...quote, today: { ...money, amount: '40000.00', amount_minor: 4000000 } }
      }
    });
    expect(job.state).toBe('awaiting_confirmation');
    expect(job.result).toMatchObject({ quote: { today: { amount_minor: 4000000 } } });
    expect(audit.append).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('同套餐核验以未付款终态结束，不制造新成功订单或单次授权', async () => {
    const { local, job } = harness();
    await local.callback(id, agentToken, {
      type: 'finished',
      result: {
        status: 'already_subscribed',
        account_matched: true,
        current_plan: 'plus',
        target_plan: 'plus',
        payment_attempted: false,
        payment_requests_sent: 0
      }
    });
    expect(job.state).toBe('finished');
    expect(job.result).toMatchObject({
      status: 'already_subscribed',
      payment_attempted: false,
      payment_requests_sent: 0
    });
    expect(job.nonceHash).toBeNull();
  });
  it('只保留有效期和报价摘要，单次确认、卡资料与密码均被清除', () => {
    const clean = safeDocument({
      ...result(),
      cvc: 'synthetic-cvc',
      password: 'synthetic-password',
      sessionJson: 'synthetic-json'
    });
    expect(clean).toHaveProperty('confirmation_expires_at');
    expect(clean).toHaveProperty('quote_digest');
    expect(
      safeDocument({ quote: { ...quote, credit: { ...money, amount: '5.00', amount_minor: 500 } } })
    ).toMatchObject({ quote: { credit: { amount: '5.00', amount_minor: 500, currency: 'USD' } } });
    for (const key of ['nonce', 'cvc', 'password', 'sessionJson'])
      expect(clean).not.toHaveProperty(key);
  });
  it('旧默认注册连接不变，充值派生独立端口且不覆盖自定义地址', () => {
    expect(normalizeV2RechargeConnectorUrl('http://127.0.0.1:55321')).toBe(
      'http://127.0.0.1:55322'
    );
    expect(normalizeV2RechargeConnectorUrl('http://localhost:55322')).toBe(
      'http://localhost:55322'
    );
    expect(normalizeV2RechargeConnectorUrl('http://127.0.0.1:55330')).toBe(
      'http://127.0.0.1:55330'
    );
  });
});
