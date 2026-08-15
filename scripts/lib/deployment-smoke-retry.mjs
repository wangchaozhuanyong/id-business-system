export const TRANSIENT_DEPLOYMENT_STATUSES = new Set([502, 503, 504]);

export async function fetchWithDeploymentRetry(
  url,
  options,
  {
    fetchImpl = fetch,
    maxAttempts = 5,
    retryDelayMs = 1_000,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))
  } = {}
) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, options);
      if (!TRANSIENT_DEPLOYMENT_STATUSES.has(response.status) || attempt === maxAttempts) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) throw error;
    }

    await sleep(retryDelayMs);
  }

  throw lastError ?? new Error('生产巡检重试已耗尽');
}
