import { describe, expect, it } from 'vitest';
import { quotePlaceholder, statusLabel, subscriptionLabel } from './recharge-presentation';
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
    expect(statusLabel('internal_unknown_reason')).toBe('待核验');
  });
});
