import { beforeEach, describe, expect, it, vi } from 'vitest';
import { birthDate, startInput, offer } from './registration-validation';
const random = vi.hoisted(() => ({ age: vi.fn(() => 20) }));
vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof import('node:crypto')>()),
  randomInt: random.age
}));
const now = new Date('2026-10-02T12:00:00Z');
const input = {
  mailboxAliasId: 'alias-1',
  proxyId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  confirmIdentity: true
};
beforeEach(() => random.age.mockReset().mockReturnValue(20));
describe('注册资料边界', () => {
  it.each([20, 25, 45])('直接接受整数年龄 %s，不重新分配', (age) => {
    expect(startInput({ ...input, age }, now)).toMatchObject({
      age,
      birthDate: `${2026 - age}-01-01`
    });
    expect(random.age).not.toHaveBeenCalled();
  });
  it.each([20, 45])('留空时随机年龄包含边界 %s', (age) => {
    random.age.mockReturnValueOnce(age);
    expect(startInput(input, now).age).toBe(age);
    expect(random.age).toHaveBeenCalledExactlyOnceWith(20, 46);
  });
  it('清空年龄后按留空处理，跨年按业务日期推导兼容生日', () => {
    expect(startInput({ ...input, age: null }, new Date('2026-12-31T16:00:00Z'))).toMatchObject({
      age: 20,
      birthDate: '2007-01-01'
    });
  });
  it.each([19, 46, 25.5, '25', '', true, NaN, Infinity])('拒绝无效年龄 %s', (age) => {
    expect(() => startInput({ ...input, age }, now)).toThrow('年龄');
    expect(random.age).not.toHaveBeenCalled();
  });
  it('兼容已有生日请求，按生日计算年龄并保留原日期', () => {
    expect(startInput({ ...input, birthDate: '2001-10-03' }, now)).toMatchObject({
      age: 24,
      birthDate: '2001-10-03'
    });
    expect(random.age).not.toHaveBeenCalled();
    expect(() => startInput({ ...input, age: 25, birthDate: '2001-10-03' }, now)).toThrow('不一致');
  });
  it.each(['2006-10-02', '1981-10-03'])('接受实际 20 至 45 岁生日 %s', (value) => {
    expect(birthDate(value, now)).toBe(value);
  });
  it.each(['2006-10-03', '1980-10-02', '2000-02-30', '2000/01/01', ''])(
    '拒绝无效或超范围生日 %s',
    (value) => {
      expect(() => birthDate(value, now)).toThrow();
    }
  );
  it('拒绝未知字段和未授权邮箱', () => {
    expect(() => startInput({ confirmIdentity: false })).toThrow('确认');
    expect(() => startInput({ confirmIdentity: true, randomAge: 25 })).toThrow('未知');
    expect(() => offer('free')).toThrow('优惠');
  });
});
