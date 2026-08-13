import { idBusinessV2TimeApi } from '@/v2/api/businessTime';
import { toV2DateTimeInput } from '@/v2/utils/dateTime';

let serverEpochMs: number | null = null;
let synchronizedAtMonotonicMs = 0;
let synchronization: Promise<number> | null = null;

function monotonicNow() {
  return performance.now();
}

export function getV2BusinessNowMs() {
  if (serverEpochMs === null) return null;
  return serverEpochMs + (monotonicNow() - synchronizedAtMonotonicMs);
}

export function getV2BusinessNowInput() {
  const now = getV2BusinessNowMs();
  return now === null ? '' : toV2DateTimeInput(now);
}

export async function ensureV2BusinessNowMs() {
  if (serverEpochMs === null) {
    try {
      await synchronizeV2BusinessClock();
    } catch {
      return null;
    }
  }
  return getV2BusinessNowMs();
}

export async function ensureV2BusinessNowInput() {
  await ensureV2BusinessNowMs();
  return getV2BusinessNowInput();
}

export function synchronizeV2BusinessClock() {
  if (synchronization) return synchronization;

  synchronization = (async () => {
    const startedAt = monotonicNow();
    const result = await idBusinessV2TimeApi.get();
    const completedAt = monotonicNow();
    const receivedServerEpochMs = Date.parse(result.now);
    if (!Number.isFinite(receivedServerEpochMs) || result.timezone !== 'Asia/Shanghai') {
      throw new Error('服务器返回的北京时间无效');
    }

    serverEpochMs = receivedServerEpochMs + (completedAt - startedAt) / 2;
    synchronizedAtMonotonicMs = completedAt;
    return serverEpochMs;
  })().finally(() => {
    synchronization = null;
  });

  return synchronization;
}
