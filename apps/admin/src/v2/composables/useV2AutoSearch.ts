export function createV2SearchCommit(commit: () => void, delay = 300) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    cancel();
    commit();
  };
  return {
    cancel,
    flush,
    schedule() {
      cancel();
      timer = setTimeout(flush, delay);
    }
  };
}

const mountedSearchInputs = new Map<symbol, { key: string; reset: () => void }>();

export function registerV2SearchInput(key: string, reset: () => void) {
  const id = Symbol(key);
  mountedSearchInputs.set(id, { key, reset });
  return () => {
    mountedSearchInputs.delete(id);
  };
}

/** 重置筛选时同时取消尚未提交的输入，防止计时器把旧搜索词写回来。 */
export function resetV2SearchInputs(prefix: string) {
  for (const input of mountedSearchInputs.values()) {
    if (input.key.startsWith(prefix)) input.reset();
  }
}
