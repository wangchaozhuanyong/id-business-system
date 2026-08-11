import { onScopeDispose } from 'vue';

export interface V2LatestRequestHandle {
  signal: AbortSignal;
  isCurrent: () => boolean;
  finish: () => void;
}

export function useV2LatestRequest() {
  let revision = 0;
  let controller: AbortController | undefined;

  function begin(): V2LatestRequestHandle {
    controller?.abort();
    const requestRevision = ++revision;
    const requestController = new AbortController();
    controller = requestController;

    return {
      signal: requestController.signal,
      isCurrent: () =>
        revision === requestRevision &&
        controller === requestController &&
        !requestController.signal.aborted,
      finish: () => {
        if (controller === requestController) controller = undefined;
      }
    };
  }

  function cancel() {
    revision += 1;
    controller?.abort();
    controller = undefined;
  }

  onScopeDispose(cancel);

  return { begin, cancel };
}
