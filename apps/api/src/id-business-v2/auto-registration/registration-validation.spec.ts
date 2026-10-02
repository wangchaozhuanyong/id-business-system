import { describe, expect, it } from 'vitest';
import { birthDate, startInput, offer } from './registration-validation';
const now = new Date('2026-10-02T12:00:00Z');
describe('注册资料边界', () => {
  it.each(['2006-10-02', '1981-10-03'])('接受实际 20 至 45 岁生日 %s', (value) => {
    expect(birthDate(value, now)).toBe(value);
  });
  it.each(['2006-10-03', '1980-10-02', '2000-02-30', '2000/01/01', ''])(
    '拒绝无效或超范围生日 %s',
    (value) => {
      expect(() => birthDate(value, now)).toThrow();
    }
  );
  it('不使用随机年龄替代真实资料，拒绝未知字段和未授权邮箱', () => {
    expect(() => startInput({ confirmIdentity: false })).toThrow('确认');
    expect(() => startInput({ confirmIdentity: true, randomAge: 25 })).toThrow('未知');
    expect(() => offer('free')).toThrow('优惠');
  });
});
