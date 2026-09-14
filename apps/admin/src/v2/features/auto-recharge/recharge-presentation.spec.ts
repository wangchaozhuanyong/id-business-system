import { describe, expect, it } from 'vitest';
import {
  browserFailureLabel,
  currencyOptions,
  failureReasonLabel,
  paymentFailureLabel,
  quotePlaceholder,
  rechargeIssueFeedback,
  statusLabel,
  subscriptionLabel,
  paymentStatusLabel
} from './recharge-presentation';
import type { V2RechargeJob } from './contracts';

const job = (overrides: Partial<V2RechargeJob> = {}): V2RechargeJob => ({
  id: 'test',
  plan: 'plus',
  action: 'check',
  state: 'finished',
  result: { stage: 'session_verified', account_matched: true },
  createdAt: '',
  updatedAt: '',
  ...overrides
});
describe('recharge stage presentation', () => {
  it('加载重试与底层错误显示中文，不显示内部异常原文', () => {
    expect(statusLabel('session_load_timeout')).toContain('等待时间');
    expect(statusLabel('bitbrowser_profile_rebuilding')).toContain('重新创建');
    expect(browserFailureLabel('TimeoutError')).toBe('等待超时');
    expect(browserFailureLabel('Error', 'net::ERR_PROXY_CONNECTION_FAILED')).toBe('代理连接失败');
    expect(browserFailureLabel('private=secret', 'private=secret')).toBe('浏览器操作异常');
    expect(browserFailureLabel('constructor', 'constructor')).toBe('浏览器操作异常');
  });
  it('默认将菲律宾比索放在首项并显示中文币种名称', () => {
    expect(currencyOptions[0]).toEqual({ value: 'PHP', label: '菲律宾比索（PHP）' });
    expect(currencyOptions.find((currency) => currency.value === 'USD')?.label).toBe('美元（USD）');
  });
  it('distinguishes unchecked, pending and failed quotes', () => {
    expect(quotePlaceholder(job())).toBe('待获取报价');
    expect(quotePlaceholder(job({ action: 'quote', state: 'running' }))).toBe('正在获取报价');
    expect(
      quotePlaceholder(job({ action: 'quote', result: { reason: 'official_plan_tier_not_found' } }))
    ).toBe('获取失败');
    expect(quotePlaceholder(job({ action: 'quote', state: 'unknown' }))).toBe('报价结果待核验');
  });
  it('keeps missing parts of an actual quote unknown', () => {
    expect(
      quotePlaceholder(
        job({
          result: {
            quote: { plan: 'plus', today: null, tax: null, renewal: null, renewal_interval: null }
          }
        })
      )
    ).toBe('未知');
  });
  it('does not describe an attempted or unknown payment as never attempted', () => {
    expect(subscriptionLabel(job())).toBe('尚未执行开通');
    expect(subscriptionLabel(job({ state: 'confirming' }))).toBe('结果待核验');
    expect(subscriptionLabel(job({ result: { payment_attempted: true } }))).toBe('结果待核验');
    expect(subscriptionLabel(job({ result: { payment_outcome: 'paid_pending_activation' } }))).toBe(
      '已付款，待开通'
    );
  });
  it('does not label a pending or completed payment outcome as unattempted', () => {
    expect(paymentStatusLabel(job({ state: 'confirming' }))).toBe('正在提交本次付款');
    expect(paymentStatusLabel(job({ result: { payment_outcome: 'subscription_activated' } }))).toBe(
      '付款结果待核验'
    );
    expect(paymentStatusLabel(job({ result: { payment_status: 'paid' } }))).toBe('已确认付款');
  });
  it('历史未知付款处理后保留处理语义，不再显示金额未知', () => {
    const resolved = job({
      action: 'bitbrowser',
      result: {
        status: 'payment_result_unknown',
        payment_status: 'unknown',
        payment_attempted: true,
        confirmation_requests_sent: 1,
        operator_resolution: 'confirmed_no_bank_request'
      }
    });
    expect(quotePlaceholder(resolved)).toBe('历史记录已处理');
    expect(paymentStatusLabel(resolved)).toBe('已确认银行卡未收到付款请求');
    expect(subscriptionLabel(resolved)).toBe('尚未开通');
  });
  it('shows a specific Chinese reason for the observed old Plus failure', () => {
    expect(statusLabel('official_plus_option_not_found')).toBe('未找到官网 Plus 选项');
    expect(statusLabel('official_plan_tier_not_found')).toBe('未识别到所选 Pro 档位');
    expect(statusLabel('official_pricing_plan_entry_not_found')).toBe(
      '未找到唯一的官网套餐定价入口'
    );
  });
  it('shows safe Chinese-only reasons for memory exhaustion and verification', () => {
    expect(statusLabel('browser_memory_exhausted')).toBe(
      '官网浏览器内存不足，本次未创建订单或付款'
    );
    expect(statusLabel('verification_required')).toBe('官网要求真人验证，本次已安全停止');
    expect(statusLabel('quote_needs_review_or_billing')).toBe(
      '官网初始总额或预估税费未完整读取，本次未付款'
    );
    expect(statusLabel('existing_checkout_unavailable')).toBe('原结算已失效，本次未付款');
    expect(statusLabel('bank_card_number_invalid')).toBe('银行卡号格式无效');
    expect(statusLabel('internal_unknown_reason')).toBe('待核验');
  });
  it('显示具体的银行拒付原因和处理方式', () => {
    const declined = job({
      action: 'bitbrowser',
      result: {
        status: 'payment_failed',
        payment_status: 'declined',
        payment_attempted: true,
        payment_requests_sent: 1,
        payment_failure_reason: 'insufficient_funds'
      }
    });
    expect(paymentFailureLabel('insufficient_funds')).toBe('银行卡余额或可用额度不足');
    expect(rechargeIssueFeedback(declined)).toEqual({
      title: '付款失败原因',
      message: '银行卡余额或可用额度不足',
      action: '请核对银行卡状态、余额、限额和银行限制；系统不会自动重复付款。'
    });
  });
  it('不暴露未知内部错误码，仍给出可操作提示', () => {
    const unknownFailure = job({
      action: 'bitbrowser',
      result: { reason: 'private_internal_error', payment_attempted: false }
    });
    expect(failureReasonLabel('private_internal_error')).toBe('系统未识别到具体失败原因');
    expect(rechargeIssueFeedback(unknownFailure)).toMatchObject({
      title: '本次未完成原因',
      message: '系统未识别到具体失败原因'
    });
    expect(JSON.stringify(rechargeIssueFeedback(unknownFailure))).not.toContain(
      'private_internal_error'
    );
  });
  it('付款结果未知时明确提示只读复查', () => {
    const pending = job({
      action: 'bitbrowser',
      state: 'unknown',
      result: {
        status: 'payment_result_unknown',
        payment_status: 'unknown',
        payment_attempted: true
      }
    });
    expect(rechargeIssueFeedback(pending)).toMatchObject({
      title: '结果待核验',
      message: '官网或本机连接器没有返回可确认的最终结果'
    });
    expect(rechargeIssueFeedback(pending)?.action).toContain('只读复查原订单');
  });
});
