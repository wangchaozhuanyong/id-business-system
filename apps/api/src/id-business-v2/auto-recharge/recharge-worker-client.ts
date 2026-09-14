import { ServiceUnavailableException } from '@nestjs/common';

type WorkerReceipt = 'accepted' | 'details_received' | 'confirmation_received' | 'cancelled';

export type RechargeWorkerDelivery = 'accepted' | 'not_received' | 'unknown';

export function isRechargeWorkerConfigured() {
  return (process.env.AUTO_RECHARGE_WORKER_TOKEN?.length ?? 0) >= 32;
}

async function readRechargeWorkerReceipt(
  id: string
): Promise<Record<string, unknown> & { knownMissing: boolean }> {
  const base = process.env.AUTO_RECHARGE_WORKER_URL ?? 'http://auto-recharge:8051';
  try {
    const response = await fetch(`${base}/jobs/${id}/status`, {
      redirect: 'error',
      headers: { 'X-Recharge-Worker': process.env.AUTO_RECHARGE_WORKER_TOKEN! },
      signal: AbortSignal.timeout(3000)
    });
    if (response.status === 404) return { knownMissing: true };
    if (!response.ok) return { knownMissing: false };
    const value = (await response.json()) as Record<string, unknown>;
    return { knownMissing: false, ...value };
  } catch {
    return { knownMissing: false };
  }
}

export async function sendRechargeWorkerRequest(
  path: string,
  body: object,
  id: string,
  receipt: WorkerReceipt
): Promise<RechargeWorkerDelivery> {
  if (!isRechargeWorkerConfigured()) {
    throw new ServiceUnavailableException('服务器执行器尚未配置');
  }
  const base = process.env.AUTO_RECHARGE_WORKER_URL ?? 'http://auto-recharge:8051';
  try {
    const response = await fetch(base + path, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'X-Recharge-Worker': process.env.AUTO_RECHARGE_WORKER_TOKEN!
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    if (response.ok) return 'accepted';
  } catch {
    /* 只读查询本次编号，不重发写请求。 */
  }
  const status = await readRechargeWorkerReceipt(id);
  if (status[receipt] === true) return 'accepted';
  return status.knownMissing ? 'not_received' : 'unknown';
}
