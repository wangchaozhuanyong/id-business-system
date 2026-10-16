import { afterEach, describe, expect, it, vi } from 'vitest';
import { automaticLoginCode } from './recharge-login-code';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./api', () => ({ rechargeApi: { loginCode: mocks.request } }));
afterEach(() => vi.resetAllMocks());
const challenge = { kind: 'email' as const, challengeId: 'challenge' };
const response = () => ({
  pending: false,
  token: '123456',
  expiresAt: new Date(Date.now() + 30_000).toISOString(),
  ...challenge
});
describe('自动登录验证码响应核对', () => {
  it('等待回执始终绑定同一任务账号和挑战，不从页面猜测类型', async () => {
    mocks.request.mockResolvedValueOnce({ pending: true }).mockResolvedValueOnce(response());
    const signal = new AbortController().signal;
    expect(await automaticLoginCode('job', 'account', challenge, signal)).toMatchObject({
      token: '123456'
    });
    expect(mocks.request).toHaveBeenCalledTimes(2);
    for (const call of mocks.request.mock.calls)
      expect(call).toEqual(['job', { accountId: 'account', ...challenge }, { signal }]);
  });
  it.each(['kind', 'challenge', 'expired', 'invalid'])('拒绝不匹配或失效的 %s', async (change) => {
    const value = response();
    if (change === 'kind') Object.assign(value, { kind: 'totp' });
    if (change === 'challenge') value.challengeId = 'other';
    if (change === 'expired') value.expiresAt = new Date(0).toISOString();
    if (change === 'invalid') value.expiresAt = 'invalid';
    mocks.request.mockResolvedValue(value);
    await expect(
      automaticLoginCode('job', 'account', challenge, new AbortController().signal)
    ).rejects.toThrow('不匹配或已过期');
    expect(mocks.request).toHaveBeenCalledOnce();
  });
  it('请求中止后不接收迟到验证码', async () => {
    const controller = new AbortController();
    mocks.request.mockImplementation(async () => {
      controller.abort();
      return response();
    });
    await expect(
      automaticLoginCode('job', 'account', challenge, controller.signal)
    ).rejects.toThrow();
  });
});
