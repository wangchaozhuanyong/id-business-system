import { rechargeApi } from './api';

export interface RechargeLoginChallenge {
  kind: 'email' | 'totp';
  challengeId: string;
}

export async function automaticLoginCode(
  jobId: string,
  accountId: string,
  challenge: RechargeLoginChallenge,
  signal: AbortSignal
) {
  const deadline = Date.now() + 123_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const result = await rechargeApi.loginCode(jobId, { accountId, ...challenge }, { signal });
    signal.throwIfAborted();
    if (result.pending) continue;
    if (
      result.kind !== challenge.kind ||
      result.challengeId !== challenge.challengeId ||
      !/^\d{6,8}$/.test(result.token ?? '') ||
      !result.expiresAt ||
      !Number.isFinite(Date.parse(result.expiresAt)) ||
      Date.parse(result.expiresAt) <= Date.now() + 3000
    )
      throw new Error('验证码与原窗口不匹配或已过期，请在原窗口继续');
    return { token: result.token!, expiresAt: result.expiresAt };
  }
  throw new Error('邮箱验证码等待超时，请在原窗口继续');
}
