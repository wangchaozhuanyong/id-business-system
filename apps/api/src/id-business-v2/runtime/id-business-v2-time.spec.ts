import { describe, expect, it } from 'vitest';
import {
  buildIdBusinessV2DateRange,
  parseIdBusinessV2DateBoundary,
  toIdBusinessV2BusinessDate
} from './id-business-v2-time';

describe('ID 业务北京时间工具', () => {
  it('按 Asia/Shanghai 计算业务日期', () => {
    expect(toIdBusinessV2BusinessDate(new Date('2026-08-11T16:00:00.000Z')).text).toBe(
      '2026-08-12'
    );
  });

  it('把北京时间自然日转换为左闭右开 UTC 区间', () => {
    expect(
      buildIdBusinessV2DateRange('2026-08-12', '2026-08-12', {
        from: '开始日期',
        to: '结束日期',
        invalidRange: '日期范围无效'
      })
    ).toEqual({
      gte: new Date('2026-08-11T16:00:00.000Z'),
      lt: new Date('2026-08-12T16:00:00.000Z')
    });
  });

  it('拒绝无效日期', () => {
    expect(() => parseIdBusinessV2DateBoundary('2026-02-30', '日期')).toThrow('日期格式无效');
  });
});
