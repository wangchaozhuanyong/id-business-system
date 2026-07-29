const latestRequestControllers = new Map<string, AbortController>();

export async function latestV2Request<T>(
  key: string,
  execute: (signal: AbortSignal) => Promise<T>
) {
  latestRequestControllers.get(key)?.abort();
  const controller = new AbortController();
  latestRequestControllers.set(key, controller);
  try {
    return await execute(controller.signal);
  } finally {
    if (latestRequestControllers.get(key) === controller) {
      latestRequestControllers.delete(key);
    }
  }
}

export function abortAllV2Requests() {
  for (const controller of latestRequestControllers.values()) controller.abort();
  latestRequestControllers.clear();
}
