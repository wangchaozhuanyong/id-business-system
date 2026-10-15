import { describe, it, expect, vi } from 'vitest';
import { RechargeNameService } from './recharge-name.service';
const { generateName } = vi.hoisted(() => ({ generateName: vi.fn() }));
vi.mock('./recharge-billing-generator', () => ({ generateRechargeBillingName: generateName }));
const operator = { id: 'operator' } as never;
const encode = (value: string) => `encrypted:${value}`;
function pan(seed: number) {
  const prefix = `400000${String(seed).padStart(9, '0')}`;
  for (let digit = 0; digit < 10; digit++) {
    const value = prefix + digit;
    const sum = [...value].reverse().reduce((sum, digit, index) => {
      const n = Number(digit) * (index % 2 ? 2 : 1);
      return sum + (n > 9 ? n - 9 : n);
    }, 0);
    if (sum % 10 === 0) return value;
  }
  throw new Error('invalid fixture');
}
function setup() {
  generateName.mockReset().mockReturnValue('James Smith');
  const names = ['Alice Example', 'Bob Example', 'Chen Example'].map((name, sequence) => ({
    id: `name-${sequence}`,
    sequence,
    nameEncrypted: encode(name),
    matchCount: 0,
    active: true,
    updatedAt: new Date()
  }));
  const bindings = new Map<
    string,
    { nameEncrypted: string; confirmed: boolean; nameId?: string }
  >();
  const repository = {
    lock: vi.fn(),
    card: vi.fn().mockResolvedValue(null),
    binding: vi.fn(async (_tx, hash) => bindings.get(hash) ?? null),
    next: vi.fn(
      async () =>
        names
          .filter((name) => name.active)
          .sort((a, b) => a.matchCount - b.matchCount || a.sequence - b.sequence)[0] ?? null
    ),
    update: vi.fn(async (_tx, id) => {
      const name = names.find((name) => name.id === id)!;
      name.matchCount++;
      return name;
    }),
    bind: vi.fn(async (_tx, hash, nameEncrypted, confirmed, nameId) => {
      bindings.set(hash, { nameEncrypted, confirmed, nameId });
    }),
    createCard: vi.fn(async (_tx, data) => ({ ...data, id: 'new-card' }))
  };
  const transactions = { execute: vi.fn(async (work) => work({})) };
  const audit = { append: vi.fn() };
  const encryption = {
    encrypt: encode,
    decrypt: (value: string) => value?.replace('encrypted:', '') ?? null,
    hash: (value: string) => `hash:${value}`
  };
  return {
    names,
    bindings,
    repository,
    audit,
    service: new RechargeNameService(
      repository as never,
      transactions as never,
      audit as never,
      encryption as never
    )
  };
}
describe('自动生成姓名及银行卡稳定绑定', () => {
  it('空姓名库也能生成新卡姓名，保存加密临时绑定，不消费原姓名库', async () => {
    const { service, names, repository, bindings, audit } = setup();
    names.forEach((name) => (name.active = false));
    const number = pan(1);
    expect(await service.match({ number }, operator)).toMatchObject({
      name: 'James Smith',
      confirmed: false
    });
    expect(bindings.get(`hash:${number}`)).toMatchObject({
      nameEncrypted: encode('James Smith'),
      confirmed: false
    });
    expect(repository.next).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('James Smith');
  });
  it('重复输入同一完整卡号保留姓名，空格格式不改变绑定，不同卡号独立生成', async () => {
    const { service } = setup();
    generateName.mockReturnValueOnce('James Smith').mockReturnValueOnce('Mary Johnson');
    const first = await service.match({ number: pan(1) }, operator);
    const repeated = await service.match({ number: pan(1).replace(/(.{4})/g, '$1 ') }, operator);
    expect(repeated.name).toBe(first.name);
    expect(generateName).toHaveBeenCalledOnce();
    expect((await service.match({ number: pan(2) }, operator)).name).toBe('Mary Johnson');
  });
  it('保留未确认的原姓名库分配，不用生成值覆盖', async () => {
    const { service, bindings } = setup();
    bindings.set(`hash:${pan(1)}`, {
      nameEncrypted: encode('Legacy Person'),
      confirmed: false,
      nameId: 'legacy'
    });
    expect(await service.match({ number: pan(1) }, operator)).toMatchObject({
      name: 'Legacy Person',
      confirmed: false
    });
    expect(generateName).not.toHaveBeenCalled();
  });
  it('优先使用旧银行卡姓名，姓名库即使没有可用姓名也不重新分配', async () => {
    const { service, repository, names } = setup();
    names.forEach((name) => (name.active = false));
    repository.card.mockResolvedValue({
      id: 'old-card',
      active: true,
      billingNameEncrypted: encode('Existing Person'),
      billingAddressId: 'address'
    });
    expect(await service.match({ number: pan(1) }, operator)).toMatchObject({
      name: 'Existing Person',
      confirmed: true,
      cardId: 'old-card'
    });
    expect(repository.next).not.toHaveBeenCalled();
  });
  it('停用卡不能生成或覆盖姓名', async () => {
    const { service, repository } = setup();
    repository.card.mockResolvedValue({ active: false });
    await expect(service.match({ number: pan(3) }, operator)).rejects.toThrow('已停用');
    expect(generateName).not.toHaveBeenCalled();
    expect(repository.bind).not.toHaveBeenCalled();
  });
  it('银行卡资料删除后通过盲索引仍能识别已确认姓名，审计不含完整卡号或姓名', async () => {
    const { service, audit } = setup();
    const number = pan(1);
    await service.match({ number }, operator);
    await service.confirm({} as never, `hash:${number}`, encode('Chosen Person'));
    expect((await service.match({ number }, operator)).name).toBe('Chosen Person');
    expect((await service.match({ number }, operator)).confirmed).toBe(true);
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain(number);
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('Chosen Person');
  });
  it('确认后拒绝换姓名；新卡登记保存加密卡号且拒绝错误币种', async () => {
    const { service, repository } = setup();
    const number = pan(1);
    await service.confirm({} as never, `hash:${number}`, encode('Existing Person'));
    await expect(
      service.prepareCard(
        {} as never,
        { number, expiry: '12/39', name: 'Wrong Person', currencyCode: 'USD' },
        operator
      )
    ).rejects.toThrow('历史绑定');
    await service.prepareCard(
      {} as never,
      { number, expiry: '12/39', name: 'Existing Person', currencyCode: 'USD' },
      operator
    );
    expect(repository.createCard.mock.calls[0][1].numberEncrypted).toBe(encode(number));
    repository.card.mockResolvedValue({ active: true, currencyCode: 'PHP' });
    await expect(
      service.prepareCard(
        {} as never,
        { number, expiry: '12/39', name: 'Existing Person', currencyCode: 'USD' },
        operator
      )
    ).rejects.toThrow('币种不匹配');
  });
});
