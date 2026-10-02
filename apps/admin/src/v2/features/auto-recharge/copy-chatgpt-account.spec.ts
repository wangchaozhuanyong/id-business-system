import { describe, expect, it, vi } from 'vitest';
import { copyChatgptAccount } from './copy-chatgpt-account';

describe('账号资料复制', () => {
  it('只在请求成功后复制完整内容，并清空临时响应', async () => {
    const details = {
      text: 'fixture@example.invalid--------fixture-2fa----BUY-TEST\n后缀\n第二行'
    };
    const expected = details.text;
    const write = vi.fn().mockResolvedValue(undefined);
    await copyChatgptAccount(async () => details, write);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(expected);
    expect(details.text).toBe('');
  });

  it('剪贴板拒绝时也清空临时响应，保留错误供重试', async () => {
    const details = { text: 'synthetic-private-data' };
    await expect(
      copyChatgptAccount(
        async () => details,
        async () => {
          throw new Error('clipboard unavailable');
        }
      )
    ).rejects.toThrow('clipboard unavailable');
    expect(details.text).toBe('');
  });

  it('查询码获取失败时不复制残缺资料', async () => {
    const write = vi.fn();
    await expect(
      copyChatgptAccount(async () => {
        throw new Error('买家查询码已失效');
      }, write)
    ).rejects.toThrow('已失效');
    expect(write).not.toHaveBeenCalled();
  });
});
