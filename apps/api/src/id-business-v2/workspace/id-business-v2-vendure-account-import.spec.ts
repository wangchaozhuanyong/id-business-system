import { describe, expect, it, vi } from 'vitest';
import { ensureVendureAccountAliases } from './id-business-v2-vendure-account-import';

const primary = { id: 'primary-1', email: 'primary@example.invalid', status: 'ACTIVE' };
const alias = (email: string, extra = {}) => ({
  id: email,
  aliasEmail: email,
  primaryAccountId: primary.id,
  status: 'ACTIVE',
  buyerQueryCode: 'BUY-EXISTING',
  ...extra
});
function fixture(initial: ReturnType<typeof alias>[] = []) {
  const records = [...initial];
  const client = {
    primaryAccounts: vi.fn().mockResolvedValue([primary]),
    virtualEmails: vi.fn(async () => records)
  };
  const create = vi.fn(async (raw: string) => {
    records.push(...raw.split('\n').map((email) => alias(email)));
  });
  const ensure = (emails: string[]) =>
    ensureVendureAccountAliases(client as never, primary.id, emails, create);
  return { client, create, ensure, records };
}

describe('ChatGPT 隐藏邮箱导入关联', () => {
  it('已有邮箱复用原查询码，只添加缺失邮箱并确认读回', async () => {
    const existing = alias('existing@example.invalid');
    const { ensure, create, records, client } = fixture([existing]);
    await ensure(['EXISTING@example.invalid', ' new@example.invalid ', 'new@example.invalid']);
    expect(create).toHaveBeenCalledExactlyOnceWith('new@example.invalid');
    expect(records[0]).toBe(existing);
    expect(existing.buyerQueryCode).toBe('BUY-EXISTING');
    expect(client.virtualEmails).toHaveBeenCalledTimes(2);
    await ensure(['existing@example.invalid', 'new@example.invalid']);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([{ primaryAccountId: 'another-primary' }, { status: 'DISABLED' }])(
    '归属冲突或停用时不新增也不重置',
    async (extra) => {
      const { ensure, create } = fixture([alias('existing@example.invalid', extra)]);
      await expect(ensure(['existing@example.invalid', 'new@example.invalid'])).rejects.toThrow();
      expect(create).not.toHaveBeenCalled();
    }
  );

  it('邮箱归属不唯一时拒绝继续', async () => {
    const { ensure, create } = fixture([
      alias('existing@example.invalid'),
      alias('existing@example.invalid')
    ]);
    await expect(ensure(['existing@example.invalid'])).rejects.toThrow('不唯一');
    expect(create).not.toHaveBeenCalled();
  });

  it('主邮箱不存在、停用或被当作隐藏邮箱时拒绝', async () => {
    const { ensure, client, create } = fixture();
    await expect(ensure([primary.email])).rejects.toThrow('所属主邮箱');
    client.primaryAccounts
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...primary, status: 'DISABLED' }]);
    await expect(ensure(['hidden@example.invalid'])).rejects.toThrow('正常主邮箱');
    await expect(ensure(['hidden@example.invalid'])).rejects.toThrow('正常主邮箱');
    expect(create).not.toHaveBeenCalled();
  });

  it('部分添加时拒绝完成，重试只补缺失邮箱', async () => {
    const { ensure, create, records } = fixture();
    create.mockImplementationOnce(async (raw) => {
      records.push(alias(raw.split('\n')[0]!));
    });
    await expect(ensure(['first@example.invalid', 'second@example.invalid'])).rejects.toThrow(
      '账号整批未导入'
    );
    await ensure(['first@example.invalid', 'second@example.invalid']);
    expect(create.mock.calls[1]).toEqual(['second@example.invalid']);
    expect(records).toHaveLength(2);
  });

  it('上游失败不声称关联完成', async () => {
    const { ensure, create } = fixture();
    create.mockRejectedValueOnce(new Error('upstream unavailable'));
    await expect(ensure(['hidden@example.invalid'])).rejects.toThrow('upstream unavailable');
  });
});
