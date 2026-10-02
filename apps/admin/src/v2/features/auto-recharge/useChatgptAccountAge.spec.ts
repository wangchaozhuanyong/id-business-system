import { describe, expect, it } from 'vitest';
import { chatgptAccountRegisteredDays } from './useChatgptAccountAge';

describe('ChatGPT 账号已注册天数', () => {
  const registeredAt = '2026-01-01T10:15:00+08:00';
  it.each([
    ['2026-01-01T10:15:00+08:00', 0],
    ['2026-01-02T00:00:00+08:00', 0],
    ['2026-01-02T10:14:59.999+08:00', 0],
    ['2026-01-02T10:15:00+08:00', 1],
    ['2026-01-30T10:15:00+08:00', 29],
    ['2026-02-01T10:15:00+08:00', 31],
    ['2026-01-02T02:15:00Z', 1],
    ['2025-12-31T10:15:00+08:00', 0]
  ])('按录入时刻计算完整 24 小时：%s → %s 天', (now, days) => {
    expect(chatgptAccountRegisteredDays(registeredAt, Date.parse(now))).toBe(days);
  });
  it('跨闰年月份按实际经过天数计算', () => {
    expect(
      chatgptAccountRegisteredDays('2024-02-01T02:15:00Z', Date.parse('2024-03-01T02:15:00Z'))
    ).toBe(29);
  });
  it('未同步服务器时钟或缺失日期时不显示虚假的零天', () => {
    expect(chatgptAccountRegisteredDays(registeredAt, null)).toBeNull();
    expect(chatgptAccountRegisteredDays('', Date.parse(registeredAt))).toBeNull();
    expect(chatgptAccountRegisteredDays(registeredAt, NaN)).toBeNull();
  });
});
