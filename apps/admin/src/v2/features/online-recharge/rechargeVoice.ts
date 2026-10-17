import type { OnlinePlan, OnlineRechargeVoicePage } from './contracts';

const PLAN_NAMES: Record<OnlinePlan, string> = {
  plus: 'Plus 套餐',
  pro_5x: 'Pro 100 套餐',
  pro_20x: 'Pro 200 套餐',
  pro_500: 'Pro 500 套餐'
};

export interface RechargeVoiceState {
  status: 'off' | 'starting' | 'on';
  message: string;
  error: boolean;
}

interface VoiceDependencies {
  allowed: () => boolean;
  read: (cursor: string, signal: AbortSignal) => Promise<OnlineRechargeVoicePage>;
  withLock: (work: (acquired: boolean) => Promise<void>) => Promise<void>;
  speak: (text: string, onError: () => void) => void;
  cancel: () => void;
  subscribe: (refresh: () => void) => () => void;
  update: (state: RechargeVoiceState) => void;
}

interface VoiceRun {
  controller: AbortController;
  release: () => void;
  stopListening?: () => void;
  timer?: ReturnType<typeof setInterval>;
  locked: boolean;
  ready: boolean;
  busy: boolean;
  dirty: boolean;
  cursor: string;
  seen: Map<string, number>;
  newest: number;
}

// A committed first-start event is the source of truth; list refreshes never create speech.
export function createRechargeVoice(deps: VoiceDependencies) {
  let current: VoiceRun | undefined;
  const isCurrent = (run: VoiceRun) => current === run && deps.allowed();
  const update = (status: RechargeVoiceState['status'], message: string, error = false) =>
    deps.update({ status, message, error });

  function stop(message = '语音播报已关闭。', error = false) {
    const run = current;
    current = undefined;
    if (run) {
      run.controller.abort();
      clearInterval(run.timer);
      run.stopListening?.();
      if (run.locked) deps.cancel();
      run.release();
    }
    update('off', message, error);
  }

  function speak(run: VoiceRun, text: string) {
    if (!isCurrent(run)) return;
    try {
      deps.speak(text, () => {
        if (isCurrent(run)) stop('浏览器未能播放语音，请检查声音权限后重新开启。', true);
      });
    } catch {
      stop('浏览器未能播放语音，请检查声音权限后重新开启。', true);
    }
  }

  async function refresh(run: VoiceRun) {
    if (!isCurrent(run)) return;
    run.dirty = true;
    if (run.busy) return;
    run.busy = true;
    try {
      do {
        run.dirty = false;
        const page = await deps.read(run.cursor, run.controller.signal);
        if (!isCurrent(run)) return;
        if (
          !page ||
          !Array.isArray(page.items) ||
          typeof page.cursor !== 'string' ||
          !page.cursor ||
          (page.hasMore && page.cursor === run.cursor) ||
          typeof page.hasMore !== 'boolean'
        )
          throw new Error('Invalid announcement page');

        if (run.ready) {
          for (const event of page.items) {
            const at = Date.parse(event.createdAt);
            if (
              !Object.hasOwn(PLAN_NAMES, event.plan) ||
              typeof event.taskId !== 'string' ||
              !event.taskId ||
              !Number.isFinite(at) ||
              run.seen.has(event.taskId)
            )
              continue;
            run.seen.set(event.taskId, at);
            run.newest = Math.max(run.newest, at);
            speak(run, `您有新的充值订单，${PLAN_NAMES[event.plan]}。`);
            if (!isCurrent(run)) return;
          }
          // The feed overlaps one minute; retain two minutes to deduplicate reconnects.
          for (const [id, at] of run.seen) {
            if (at < run.newest - 120_000) run.seen.delete(id);
          }
        } else {
          run.ready = true;
          speak(run, '充值订单语音播报已开启。');
          if (!isCurrent(run)) return;
        }
        run.cursor = page.cursor;
        update('on', '已开启，后台保持打开时播报新开始执行的充值套餐。');
        run.dirty ||= page.hasMore;
      } while (run.dirty && isCurrent(run));
    } catch {
      if (!isCurrent(run)) return;
      if (!run.ready) stop('开启失败，请稍后重试。', true);
      else update('on', '订单提醒暂时未能刷新，将自动重试。', true);
    } finally {
      run.busy = false;
    }
  }

  function enable() {
    if (current || !deps.allowed()) return;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const run: VoiceRun = {
      controller: new AbortController(),
      release,
      locked: false,
      ready: false,
      busy: false,
      dirty: false,
      cursor: 'baseline',
      seen: new Map(),
      newest: 0
    };
    current = run;
    update('starting', '正在开启语音播报…');
    void deps
      .withLock(async (acquired) => {
        if (!isCurrent(run)) return;
        if (!acquired) {
          stop('另一个后台标签页已开启播报，请先在该页关闭。');
          return;
        }
        run.locked = true;
        run.stopListening = deps.subscribe(() => void refresh(run));
        run.timer = setInterval(() => void refresh(run), 15_000);
        await refresh(run);
        await held;
      })
      .catch(() => {
        if (isCurrent(run)) stop('此浏览器无法启用语音播报，请换用新版浏览器。', true);
      });
  }

  return {
    enable,
    stop,
    test() {
      if (current?.ready) speak(current, '语音播报测试，Pro 200 套餐。');
    }
  };
}
