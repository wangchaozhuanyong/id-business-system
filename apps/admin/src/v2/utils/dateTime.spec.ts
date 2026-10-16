import { describe, expect, it } from 'vitest';
import {
  addOneInclusiveMonthToV2DateTimeInput,
  formatV2DateTime,
  currentV2BusinessDate,
  parseV2DateTimeInput,
  toV2DateTimeInput,
  v2DateTimeInputToIso
} from './dateTime';

describe('北京时间工具', () => {
  it('注册日期在跨日边界使用北京时间且不显示虚构时分', () => {
    expect(currentV2BusinessDate('2026-09-09T16:00:00.000Z')).toBe('2026-09-10');
    expect(currentV2BusinessDate('2026-09-09T15:59:59.000Z')).toBe('2026-09-09');
    expect(currentV2BusinessDate('invalid')).toBe('');
  });
  it('使用固定北京时间显示绝对时刻', () => {
    expect(formatV2DateTime('2026-08-12T01:12:00.000Z')).toBe('2026/08/12 09:12');
    expect(toV2DateTimeInput('2026-08-12T01:12:00.000Z')).toBe('2026-08-12T09:12');
  });

  it('把无时区表单值明确解释为北京时间', () => {
    expect(v2DateTimeInputToIso('2026-08-12T09:12')).toBe('2026-08-12T01:12:00.000Z');
    expect(parseV2DateTimeInput('2026-02-30T09:12')).toBeNull();
  });

  it.each([
    ['2026-07-27T09:52', '2026-08-26T09:52'],
    ['2026-01-31T06:10', '2026-02-27T06:10'],
    ['2028-01-31T06:10', '2028-02-28T06:10'],
    ['2026-12-31T06:10', '2027-01-30T06:10']
  ])('按北京时间计算含首日一个月周期：%s', (openedAt, dueAt) => {
    expect(addOneInclusiveMonthToV2DateTimeInput(openedAt)).toBe(dueAt);
  });
});
