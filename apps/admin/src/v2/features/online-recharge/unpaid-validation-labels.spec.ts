import { describe, expect, it } from 'vitest';
import { unpaidValidationEntries } from './unpaid-validation-labels';
describe('不付款验收回显', () => {
  it('已就绪与真实充值成功分开，内部枚举不直接展示', () => {
    const entries = unpaidValidationEntries({
      format: 'unpaid-validation-v1',
      outcome: 'ready_before_payment',
      failureClass: 'NONE',
      lastStage: 'button_ready',
      cardVerified: true,
      billingVerified: true,
      buttonReady: true,
      timeline: [
        {
          stage: 'card_fill',
          startedAt: '2026-10-24T01:00:00.000Z',
          endedAt: '2026-10-24T01:00:01.000Z'
        }
      ]
    });
    expect(entries[0]?.value).toBe('付款前就绪，未提交');
    expect(JSON.stringify(entries)).not.toMatch(/ready_before_payment|button_ready|NONE|card_fill/);
    expect(entries.at(-1)?.value).toContain('1000 毫秒');
  });
  it('普通403保留状态，不声称政策或地区根因', () => {
    const rows = unpaidValidationEntries({
      format: 'unpaid-validation-v1',
      outcome: 'failed_with_class',
      failureClass: 'CHECKOUT_REJECTED',
      httpStatus: 403
    });
    expect(rows.at(-1)?.value).toBe('HTTP 403');
    expect(JSON.stringify(rows)).not.toMatch(/政策|地区限制/);
  });
});
