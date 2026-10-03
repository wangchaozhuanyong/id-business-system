import { ServiceUnavailableException } from '@nestjs/common';

const base = () => process.env.AUTO_RECHARGE_WORKER_URL ?? 'http://auto-recharge:8051';
const headers = () => ({ 'X-Recharge-Worker': process.env.AUTO_RECHARGE_WORKER_TOKEN ?? '' });
export type RegistrationDelivery = 'accepted' | 'not_received' | 'unknown';

export async function registrationWorkerReady() {
  if ((process.env.AUTO_RECHARGE_WORKER_TOKEN?.length ?? 0) < 32) return false;
  try {
    const response = await fetch(`${base()}/registration/health`, {
      redirect: 'error',
      headers: headers(),
      signal: AbortSignal.timeout(3000)
    });
    const value = response.ok ? await response.json() : null;
    return value?.ready === true && value?.engine === 'camoufox';
  } catch {
    return false;
  }
}

export async function requireRegistrationWorker() {
  if (!(await registrationWorkerReady()))
    throw new ServiceUnavailableException('系统内置浏览器尚未就绪，请联系管理员更新执行器');
}

export async function registrationWorkerCommand(
  jobId: string,
  attempt: number,
  action: 'launch' | 'resume' | 'code' | 'cancel',
  body: object
): Promise<RegistrationDelivery> {
  const path = `/registration/jobs/${jobId}`;
  try {
    const response = await fetch(base() + path + (action === 'launch' ? '' : `/${action}`), {
      method: 'POST',
      redirect: 'error',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    if (response.ok && action !== 'cancel') return 'accepted';
  } catch {
    /* 查询原编号的收据，不重发注册。 */
  }
  try {
    const response = await fetch(base() + path + '/status', {
      redirect: 'error',
      headers: headers(),
      signal: AbortSignal.timeout(3000)
    });
    if (response.status === 404) return 'not_received';
    const receipt = response.ok ? await response.json() : null;
    if (receipt?.attempt !== attempt) return 'unknown';
    if (action === 'launch' && receipt.accepted === true) return 'accepted';
    if (action === 'cancel' && receipt.cancelled === true && receipt.done === true)
      return 'accepted';
    // 验证码和继续动作没有可去重的持久收据；不能把已接收任务冒充动作成功。
  } catch {
    /* 结果不明时由原任务保留检查点。 */
  }
  return 'unknown';
}
