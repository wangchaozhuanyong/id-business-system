import { ConflictException, ServiceUnavailableException } from '@nestjs/common';

const base = () => process.env.AUTO_REGISTRATION_WORKER_URL ?? 'http://auto-registration:8051';
const headers = () => ({ 'X-Recharge-Worker': process.env.AUTO_RECHARGE_WORKER_TOKEN ?? '' });
export type RegistrationDelivery = 'accepted' | 'not_received' | 'unknown' | 'rejected';
const rejectionReasons = [
  'worker_busy',
  'builtin_original_window_pending',
  'builtin_profile_missing',
  'invalid_registration_payload',
  'fingerprint_cleanup_failed'
] as const;
export type RegistrationDispatch = {
  delivery: RegistrationDelivery;
  reason?: (typeof rejectionReasons)[number];
};

async function registrationWorkerHealth() {
  if ((process.env.AUTO_RECHARGE_WORKER_TOKEN?.length ?? 0) < 32) return null;
  try {
    const response = await fetch(`${base()}/registration/health`, {
      redirect: 'error',
      headers: headers(),
      signal: AbortSignal.timeout(3000)
    });
    const value = response.ok ? await response.json() : null;
    return value?.ready === true &&
      value?.workerRole === 'registration' &&
      value?.engine === 'camoufox' &&
      value?.mailDeliveryVersion === 1
      ? {
          registrationBusy: value.registrationBusy === true,
          windowRetained: value.registrationWindowRetained === true
        }
      : null;
  } catch {
    return null;
  }
}

export async function registrationWorkerReady() {
  return (await registrationWorkerHealth()) !== null;
}

export async function requireRegistrationWorker(requireAvailable = false) {
  const health = await registrationWorkerHealth();
  if (!health)
    throw new ServiceUnavailableException('系统内置浏览器尚未就绪，请联系管理员更新执行器');
  if (requireAvailable && health.windowRetained)
    throw new ConflictException('执行器保留了原注册窗口，请继续或取消原任务');
  if (requireAvailable && health.registrationBusy)
    throw new ConflictException('执行器已有注册任务执行中，请处理原任务');
}

export async function registrationWorkerCommand(
  jobId: string,
  attempt: number,
  action: 'launch' | 'resume' | 'code' | 'cancel',
  body: object
): Promise<RegistrationDispatch> {
  const path = `/registration/jobs/${jobId}`;
  try {
    const response = await fetch(base() + path + (action === 'launch' ? '' : `/${action}`), {
      method: 'POST',
      redirect: 'error',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    if (response.ok && action !== 'cancel') return { delivery: 'accepted' };
    if (!response.ok) {
      const value = await response.json().catch(() => null);
      if (value?.ok === false && rejectionReasons.includes(value.reason))
        return { delivery: 'rejected', reason: value.reason };
    }
  } catch {
    /* 查询原编号的收据，不重发注册。 */
  }
  try {
    const response = await fetch(base() + path + '/status', {
      redirect: 'error',
      headers: headers(),
      signal: AbortSignal.timeout(3000)
    });
    if (response.status === 404) return { delivery: 'not_received' };
    const receipt = response.ok ? await response.json() : null;
    if (receipt?.attempt !== attempt) return { delivery: 'unknown' };
    if (action === 'launch' && receipt.accepted === true) return { delivery: 'accepted' };
    if (action === 'cancel' && receipt.cancelled === true && receipt.done === true)
      return { delivery: 'accepted' };
    // 验证码和继续动作没有可去重的持久收据；不能把已接收任务冒充动作成功。
  } catch {
    /* 结果不明时由原任务保留检查点。 */
  }
  return { delivery: 'unknown' };
}
