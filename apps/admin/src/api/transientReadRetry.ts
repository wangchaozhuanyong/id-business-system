const TRANSIENT_READ_RETRY_DELAYS_MS = [180, 650] as const;

interface TransientReadRetryInput {
  aborted?: boolean;
  method?: string;
  retryCount: number;
  status?: number;
  url?: string;
}

export function getTransientReadRetryDelay({
  aborted,
  method,
  retryCount,
  status,
  url
}: TransientReadRetryInput) {
  if (aborted || status !== 503 || method?.toLowerCase() !== 'get') {
    return null;
  }

  if (!url?.includes('/id-business-v2/')) {
    return null;
  }

  return TRANSIENT_READ_RETRY_DELAYS_MS[retryCount] ?? null;
}
