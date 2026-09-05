import { describe, expect, it } from 'vitest';
import {
  maskWebsiteVisitIp,
  normalizeWebsiteVisitIp,
  parseWebsiteVisitEvent,
  parseWebsiteVisitSearch,
  websiteVisitRange
} from './id-business-v2-website-visit-input';

const event = {
  eventId: '4f7989c2-b347-41f5-98e5-09a74ce303d4',
  host: 'flashcast.com.my',
  path: '/zh/services',
  ip: '203.0.113.19',
  occurredAt: '2026-09-06T01:02:03.004Z'
};

describe('website visit input', () => {
  it('accepts only the fixed public website contract', () => {
    expect(parseWebsiteVisitEvent(event)).toEqual(event);
    expect(() => parseWebsiteVisitEvent({ ...event, host: 'evil.example' })).toThrow('网站无效');
    expect(() => parseWebsiteVisitEvent({ ...event, path: '/admin' })).toThrow('路径无效');
    expect(() => parseWebsiteVisitEvent({ ...event, query: 'secret' })).toThrow('字段无效');
    expect(() => parseWebsiteVisitEvent({ ...event, occurredAt: 'yesterday' })).toThrow('时间无效');
  });

  it('normalizes IPv4, IPv6 and IPv4-mapped IPv6 consistently and masks them', () => {
    expect(normalizeWebsiteVisitIp('203.0.113.19')).toBe('203.0.113.19');
    expect(normalizeWebsiteVisitIp('2001:0db8:0:0:0:0:0:1')).toBe('2001:db8::1');
    expect(normalizeWebsiteVisitIp('::ffff:cb00:7113')).toBe('203.0.113.19');
    expect(maskWebsiteVisitIp('203.0.113.19')).toBe('203.0.*.*');
    expect(maskWebsiteVisitIp('2001:db8::1')).toBe('2001:db8:****');
    expect(() => normalizeWebsiteVisitIp('999.1.1.1')).toThrow('有效的 IP');
  });

  it('bounds queries and builds UTC+08:00 dates across midnight', () => {
    expect(parseWebsiteVisitSearch({ days: 7, page: 1, pageSize: 20, sort: 'newest' })).toEqual({
      days: 7,
      page: 1,
      pageSize: 20,
      sort: 'newest',
      ip: undefined
    });
    expect(() =>
      parseWebsiteVisitSearch({ days: 365, page: 1, pageSize: 20, sort: 'newest' })
    ).toThrow();
    expect(websiteVisitRange(7, new Date('2026-09-05T16:30:00.000Z')).dates).toEqual([
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06'
    ]);
  });
});
