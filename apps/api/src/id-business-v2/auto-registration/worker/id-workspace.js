/* Transport, theme and draft adapter. Upstream registration algorithms are unchanged. */
(() => {
  const prefix = '/api/id-business-v2/auto-registration/workspace';
  const page = location.pathname.slice(prefix.length) || '/';
  const secretField =
    /password|passwd|pwd|secret|token|cookie|api.?key|(?:^|[-_:])key(?:$|[-_:])|authorization|credential|proxy|cvv|cvc|otp|captcha|verification.?code|security.?code|import|raw.?account|account.?data/i;
  let values = {};
  let draftApplied = false;
  let applying = false;
  let pendingState = null;
  const storage = new Map();
  const appleRequests = new Map();

  function emitDraft() {
    if (applying) return;
    parent.postMessage({ type: 'id-registration:draft', page, values }, location.origin);
  }

  function safeField(field) {
    const key = field.id || field.name;
    return (
      key &&
      !secretField.test(key) &&
      !['password', 'hidden', 'file', 'submit', 'button'].includes(field.type) &&
      !field.readOnly &&
      !field.disabled
    );
  }

  function keyOf(field) {
    const key = field.id || field.name;
    return field.type === 'radio' ? `${key}:${field.value}` : key;
  }

  function captureDraft() {
    if (applying) return;
    document.querySelectorAll('input,select,textarea').forEach((field) => {
      if (safeField(field))
        values[keyOf(field)] = ['checkbox', 'radio'].includes(field.type)
          ? field.checked
          : field.value;
    });
    emitDraft();
  }

  // Only non-secret values are delegated to the system's in-memory session draft.
  // No registration data is written to browser storage.
  const memoryStorage = {
    getItem(key) {
      return storage.get(String(key)) ?? null;
    },
    setItem(key, value) {
      key = String(key);
      if (secretField.test(key)) return;
      storage.set(key, String(value));
      values[`storage:${key}`] = String(value);
      emitDraft();
    },
    removeItem(key) {
      storage.delete(String(key));
      delete values[`storage:${key}`];
      emitDraft();
    },
    clear() {
      storage.clear();
      Object.keys(values)
        .filter((key) => key.startsWith('storage:'))
        .forEach((key) => delete values[key]);
      emitDraft();
    },
    key(index) {
      return [...storage.keys()][index] ?? null;
    },
    get length() {
      return storage.size;
    }
  };
  Object.defineProperty(window, 'localStorage', { value: memoryStorage });
  Object.defineProperty(window, 'sessionStorage', { value: memoryStorage });

  function applyState(state) {
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.dataset.v2Theme = state.theme;
    document.documentElement.classList.toggle('dark', state.theme === 'dark');
    storage.set('theme', state.theme);
    for (const [name, value] of Object.entries(state.tokens || {})) {
      if (/^--(?:v2|v3)-[a-z0-9-]+$/.test(name) && typeof value === 'string')
        document.documentElement.style.setProperty(name, value);
    }
    if (draftApplied || document.readyState === 'loading') return;
    draftApplied = true;
    applying = true;
    values = { ...(state.draft || {}) };
    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith('storage:') && !secretField.test(key))
        storage.set(key.slice(8), String(value));
    }
    document.querySelectorAll('input,select,textarea').forEach((field) => {
      const key = keyOf(field);
      if (!safeField(field) || !(key in values)) return;
      if (['checkbox', 'radio'].includes(field.type)) field.checked = values[key] === true;
      else field.value = String(values[key]);
      field.dispatchEvent(new Event('change', { bubbles: true }));
    });
    applying = false;
  }

  window.addEventListener('message', (event) => {
    if (
      event.source === parent &&
      event.origin === location.origin &&
      event.data?.type === 'id-registration:apple-response'
    ) {
      const pending = appleRequests.get(event.data.requestId);
      if (!pending) return;
      appleRequests.delete(event.data.requestId);
      clearTimeout(pending.timeout);
      if (event.data.ok) pending.resolve(event.data.data);
      else pending.reject(new Error(event.data.error || '隐藏邮箱操作失败，请重试'));
      return;
    }
    if (
      event.source !== parent ||
      event.origin !== location.origin ||
      event.data?.type !== 'id-registration:state'
    )
      return;
    if (!['light', 'dark'].includes(event.data.theme)) return;
    pendingState = event.data;
    applyState(event.data);
  });

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/api/') && !input.startsWith(prefix))
      input = prefix + input;
    return originalFetch(input, init);
  };

  // Original log messages still come from the upstream WebSocket. The browser
  // uses guarded same-origin EventSource, with regular session revalidation.
  class WorkspaceSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      this.readyState = 0;
      const parsed = new URL(url, location.href);
      const path = parsed.pathname.startsWith(prefix)
        ? parsed.pathname.slice(prefix.length)
        : parsed.pathname;
      if (!/^\/api\/ws\/(task|batch)\/[^/]+$/.test(path)) throw new Error('实时日志地址无效');
      this.path = path;
      this.streamId = crypto.randomUUID();
      this.events = new EventSource(`${prefix}${path}?streamId=${this.streamId}`);
      this.events.addEventListener('connected', () => {
        this.readyState = 1;
        this.onopen?.({});
      });
      this.events.onmessage = (event) => this.onmessage?.({ data: JSON.parse(event.data) });
      this.events.onerror = (event) => {
        this.events.close();
        this.readyState = 3;
        this.onerror?.(event);
        this.onclose?.({ code: 1006 });
      };
    }
    send(raw) {
      const message = JSON.parse(raw);
      if (!['cancel', 'ping'].includes(message.type)) return;
      window
        .fetch(`${prefix}${this.path}?streamId=${this.streamId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: message.type })
        })
        .then((response) => {
          if (!response.ok) throw new Error('实时任务操作失败');
        })
        .catch(() => this.onerror?.({ message: '取消任务失败，请重试' }));
    }
    close() {
      this.events.close();
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }
  }
  window.WebSocket = WorkspaceSocket;

  function appleRequest(action, payload = {}) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => {
        appleRequests.delete(requestId);
        reject(new Error('操作回执尚未收到，请刷新并核对原任务；不要重复提交注册'));
      }, 60000);
      appleRequests.set(requestId, { resolve, reject, timeout });
      parent.postMessage(
        { type: 'id-registration:apple-request', page: '/', requestId, action, payload },
        location.origin
      );
    });
  }

  function installAppleConsole() {
    const service = document.getElementById('email-service');
    const form = document.getElementById('registration-form');
    if (!service || !form) return;
    let candidates = [];
    let generation = 0;
    let active = null;
    let progressTimer;
    let progressGeneration = 0;
    let disposed = false;
    let optionsReady = false;
    const group = document.createElement('div');
    group.id = 'id-apple-console';
    group.hidden = true;
    group.innerHTML =
      '<div class="form-group"><label for="id-apple-choice">注册邮箱</label><select id="id-apple-choice"><option value="">自动选择一个未注册邮箱</option></select></div>' +
      '<div class="form-group" id="id-apple-batch-group" hidden><label for="id-apple-targets">批量邮箱</label><select id="id-apple-targets" multiple size="5" aria-label="指定批量注册邮箱"></select><small>未选择时按数量从可用未注册邮箱中选取；可以选择部分邮箱。</small></div>' +
      '<div class="form-group"><label for="id-system-route">注册代理</label><select id="id-system-route"><option value="">沿用原系统设置的代理</option></select></div>' +
      '<p id="id-apple-pool-status" role="status">正在读取隐藏邮箱候选</p>' +
      '<p id="id-apple-pool-error" role="alert"></p>' +
      '<button type="button" class="btn btn-ghost" id="id-apple-refresh">刷新邮箱池</button>';
    service.closest('.form-group').after(group);
    const choice = document.getElementById('id-apple-choice');
    const targets = document.getElementById('id-apple-targets');
    const route = document.getElementById('id-system-route');
    const hint = document.getElementById('id-apple-pool-status');
    const error = document.getElementById('id-apple-pool-error');
    const refresh = document.getElementById('id-apple-refresh');
    const mode = document.getElementById('reg-mode');
    const start = document.getElementById('start-btn');
    const cancel = document.getElementById('cancel-btn');
    const selected = () => service.value === 'apple_hidden';
    const usable = () =>
      candidates.filter((row) => row.canRegister && row.registrationStatus === 'unregistered');
    function option(value, text, disabled = false) {
      const item = document.createElement('option');
      item.value = value;
      item.textContent = text;
      item.disabled = disabled;
      return item;
    }
    function ensureService() {
      if (!service.querySelector('option[value="apple_hidden"]')) {
        service.appendChild(option('apple_hidden', '系统苹果隐藏邮箱'));
        if (values['email-service'] === 'apple_hidden') {
          service.value = 'apple_hidden';
          service.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }
    const observer = new MutationObserver(ensureService);
    observer.observe(service, { childList: true, subtree: true });
    ensureService();
    function updateAvailability() {
      group.hidden = !selected();
      document.documentElement.dataset.appleRegistration = String(selected());
      document.getElementById('interval-max').min = selected() ? '0' : '1';
      document.getElementById('id-apple-batch-group').style.display =
        mode.value === 'batch' ? 'grid' : 'none';
      choice.closest('.form-group').style.display = mode.value === 'batch' ? 'none' : 'grid';
      if (selected()) {
        const available = usable().length;
        hint.textContent = optionsReady
          ? `可注册 ${available} 个邮箱，共 ${candidates.length} 个。批量数量不足时按实际可用数量执行。`
          : '正在读取隐藏邮箱候选';
        start.disabled = Boolean(active) || !optionsReady || available === 0;
        if (optionsReady && available === 0)
          hint.textContent = '没有可注册的未注册邮箱，请添加邮箱或核对状态；不会改用其他邮箱服务。';
        cancel.disabled = !active || active.uncertain === true;
      }
    }
    async function loadOptions() {
      const current = ++generation;
      refresh.disabled = true;
      error.textContent = '';
      try {
        const data = await appleRequest('candidates');
        if (current !== generation) return;
        const oldChoice = choice.value || values['id-apple-choice'] || '';
        const oldRoute = route.value || values['id-system-route'] || '';
        let storedTargets = [];
        try {
          storedTargets = JSON.parse(values['id-apple-picked'] || '[]');
        } catch {
          /* Ignore invalid draft. */
        }
        const oldTargets = new Set(
          [...targets.selectedOptions]
            .map((item) => item.value)
            .concat(Array.isArray(storedTargets) ? storedTargets : [])
        );
        candidates = data.items || [];
        optionsReady = true;
        choice.replaceChildren(option('', '自动选择一个未注册邮箱'));
        targets.replaceChildren();
        candidates.forEach((row) => {
          const available = row.canRegister && row.registrationStatus === 'unregistered';
          const label = `${row.email} · ${available ? '未注册，可用' : row.blockedReason || '暂不可注册'}`;
          choice.appendChild(option(row.aliasId, label, !available));
          const item = option(row.aliasId, label, !available);
          item.selected = oldTargets.has(row.aliasId);
          targets.appendChild(item);
        });
        if (oldChoice) {
          if (!candidates.some((row) => row.aliasId === oldChoice))
            choice.appendChild(option(oldChoice, '原选邮箱已不可用，请重新选择', true));
          choice.value = oldChoice;
        }
        route.replaceChildren(option('', '沿用原系统设置的代理'));
        (data.proxies || []).forEach((item) => route.appendChild(option(item.id, item.label)));
        if (oldRoute) {
          if (!(data.proxies || []).some((item) => item.id === oldRoute))
            route.appendChild(option(oldRoute, '原选代理已不可用，请重新选择', true));
          route.value = oldRoute;
        }
      } catch (failure) {
        if (current !== generation) return;
        error.textContent = failure.message;
        // Existing candidates remain visible, but cannot be submitted after a failed refresh.
        optionsReady = false;
      } finally {
        if (current === generation) {
          refresh.disabled = false;
          updateAvailability();
        }
      }
    }
    function log(message, level = 'info') {
      if (typeof window.addLog === 'function') window.addLog(level, message);
      else error.textContent = message;
    }
    function uploadOptions() {
      const result = {};
      for (const name of ['cpa', 'sub2api', 'tm']) {
        const checked = document.getElementById(`auto-upload-${name}`)?.checked === true;
        result[`auto_upload_${name}`] = checked;
        result[`${name}_service_ids`] = checked
          ? [...document.querySelectorAll(`#${name}-service-select .msd-item input:checked`)].map(
              (item) => Number(item.value)
            )
          : [];
      }
      if (route.value) result.proxyId = route.value;
      return result;
    }
    function rememberActive() {
      if (active) values['storage:appleTask'] = JSON.stringify(active);
      else delete values['storage:appleTask'];
      emitDraft();
    }
    const taskLabels = {
      pending: '等待执行',
      running: '正在注册',
      completed: '注册任务已结束',
      failed: '注册失败',
      cancelled: '已取消',
      interrupted: '中断待核对',
      awaiting_review: '结果待核对'
    };
    const syncLabels = {
      not_ready: '尚未具备同步条件',
      not_started: '尚未开始同步',
      awaiting_identity: '等待身份核验',
      blocked: '同步条件未满足',
      quarantined: '迟到结果隔离待核对',
      pending: '等待同步',
      syncing: '正在同步',
      saved: '已同步到 ChatGPT 账号',
      failed: '账号同步失败',
      conflict: '账号冲突，等待核对'
    };
    async function poll() {
      if (disposed || !active || active.uncertain) return;
      clearTimeout(progressTimer);
      const snapshot = active;
      const attempt = ++progressGeneration;
      try {
        let tasks;
        if (active.batchId) {
          const data = await appleRequest('batch-status', { batchId: active.batchId });
          const ids = data.taskUuids || active.taskUuids || [];
          tasks = data.tasks || [];
          if (!data.tasks) {
            for (let index = 0; index < ids.length; index += 4) {
              const portion = await Promise.all(
                ids.slice(index, index + 4).map((taskUuid) => appleRequest('task', { taskUuid }))
              );
              if (disposed || active !== snapshot || attempt !== progressGeneration) return;
              tasks.push(...portion);
            }
          }
          const finished = tasks.filter(
            (task) => !['pending', 'running'].includes(task.status)
          ).length;
          if (typeof window.updateBatchProgress === 'function')
            window.updateBatchProgress({
              completed: finished,
              total: ids.length,
              success: tasks.filter((task) => task.status === 'completed').length,
              failed: tasks.filter((task) => ['failed', 'interrupted'].includes(task.status)).length
            });
        } else tasks = [await appleRequest('task', { taskUuid: active.taskUuid })];
        if (disposed || active !== snapshot || attempt !== progressGeneration) return;
        let running = false;
        for (const task of tasks) {
          (task.logs || []).forEach((line) => log(line));
          const syncStatus = task.record?.syncStatus || task.syncStatus;
          log(
            `${taskLabels[task.status] || '等待核对'}${syncStatus ? ` · ${syncLabels[syncStatus] || '同步状态待核对'}` : ''}`
          );
          const failure = task.record?.firstFailure;
          if (failure) {
            const stages = {
              queued: '注册初始化',
              signup: '提交注册表单',
              password: '注册密码提交',
              verification_code: '邮箱验证码',
              verification_validate: '验证邮箱验证码',
              create_account: '创建官网账号',
              workspace: '读取账号工作区',
              select_workspace: '选择账号工作区',
              redirect: '授权跳转',
              oauth: '注册后授权',
              identity: '账号身份核验',
              account_save: '自动注册账号保存',
              sync: 'ChatGPT 账号同步'
            };
            const errors = {
              http_rejected: '服务返回失败',
              network_error: '网络请求异常',
              unknown: '执行结果待核对',
              account_creation_failed: '官网返回账号创建失败',
              user_exists: '官网提示已有账号，需核验身份'
            };
            const status = Number.isInteger(failure.httpStatus)
              ? `响应状态 ${failure.httpStatus}`
              : '未取得响应状态';
            const elapsed =
              Number.isSafeInteger(failure.elapsedMs) && failure.elapsedMs >= 0
                ? ` · 耗时 ${failure.elapsedMs / 1000} 秒`
                : '';
            log(
              `首次失败：${stages[failure.stage] || '执行步骤待核对'} · ${errors[failure.errorKind] || '执行结果待核对'} · ${status}${elapsed}`,
              'error'
            );
          }
          if (!active.batchId && typeof window.updateTaskStatus === 'function') {
            if (['interrupted', 'awaiting_review'].includes(task.status)) {
              document.getElementById('task-status').textContent = taskLabels[task.status];
              document.getElementById('task-status-badge').textContent = taskLabels[task.status];
            } else window.updateTaskStatus(task.status);
          }
          running = running || ['pending', 'running'].includes(task.status);
        }
        if (running) progressTimer = setTimeout(poll, 2500);
        else {
          active = null;
          rememberActive();
          updateAvailability();
          void loadOptions();
          if (typeof window.loadRecentAccounts === 'function') void window.loadRecentAccounts();
        }
      } catch (failure) {
        if (disposed || active !== snapshot || attempt !== progressGeneration) return;
        error.textContent = `${failure.message}。任务状态尚未核对，点击刷新邮箱池恢复查询。`;
        log(error.textContent, 'error');
      }
    }
    form.addEventListener(
      'submit',
      async (event) => {
        if (!selected()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (active || !optionsReady || !usable().length) {
          updateAvailability();
          return;
        }
        error.textContent = '';
        const batch = mode.value === 'batch';
        if (route.value && route.selectedOptions[0]?.disabled) {
          error.textContent = '原选代理已不可用，请重新选择代理后再提交';
          return;
        }
        const options = uploadOptions();
        if (!batch && choice.value) {
          const row = usable().find((item) => item.aliasId === choice.value);
          if (!row) {
            error.textContent = '所选邮箱已不可用，请刷新邮箱池';
            return;
          }
          options.aliasId = row.aliasId;
          options.revision = row.revision;
        }
        if (batch) {
          let previousTargets = [];
          try {
            previousTargets = JSON.parse(values['id-apple-picked'] || '[]');
          } catch {
            /* Ignore invalid draft. */
          }
          const chosen = new Set(
            [...targets.selectedOptions]
              .map((item) => item.value)
              .concat(Array.isArray(previousTargets) ? previousTargets : [])
          );
          if ([...chosen].some((id) => !candidates.some((item) => item.aliasId === id))) {
            error.textContent = '部分原选邮箱已移除，请重新选择批量邮箱';
            return;
          }
          if (chosen.size)
            options.targets = candidates
              .filter((item) => chosen.has(item.aliasId))
              .map(({ aliasId, revision }) => ({ aliasId, revision }));
          options.count = Number(document.getElementById('batch-count').value);
          options.concurrency = Number(document.getElementById('concurrency-count').value);
          options.mode = document.getElementById('concurrency-mode').value;
          options.interval_min = Number(document.getElementById('interval-min').value);
          options.interval_max = Number(document.getElementById('interval-max').value);
          if (
            !Number.isInteger(options.count) ||
            options.count < 1 ||
            options.count > 100 ||
            !Number.isInteger(options.concurrency) ||
            options.concurrency < 1 ||
            options.concurrency > 50 ||
            options.interval_min < 0 ||
            options.interval_max < options.interval_min ||
            options.interval_max > 3600
          ) {
            error.textContent = '请核对数量、并发数和等待间隔';
            return;
          }
        }
        active = { uncertain: true };
        updateAvailability();
        document.getElementById('console-log').replaceChildren();
        try {
          const result = await appleRequest(batch ? 'batch' : 'start', options);
          active = batch
            ? { batchId: result.batchId, taskUuids: result.taskUuids }
            : { taskUuid: result.taskUuid };
          rememberActive();
          if (batch) {
            log(`批量已接收 ${result.accepted} 个邮箱，跳过 ${(result.skipped || []).length} 个。`);
            (result.skipped || []).forEach((item) => {
              const reasons = {
                mailbox_unavailable: '邮箱不可用或状态已变化',
                already_registered: '邮箱已注册',
                occupied: '邮箱已被其他任务占用',
                authorization_expired: '邮箱授权已失效'
              };
              log(
                reasons[item.reason] ||
                  (/^[\u4e00-\u9fff]/.test(item.reason || '')
                    ? item.reason
                    : '邮箱不可用，请核对状态'),
                'warning'
              );
            });
            if (typeof window.showBatchStatus === 'function')
              window.showBatchStatus({ count: result.accepted });
          } else if (typeof window.showTaskStatus === 'function')
            window.showTaskStatus({ task_uuid: result.taskUuid });
          updateAvailability();
          void poll();
        } catch (failure) {
          error.textContent = failure.message;
          if (!failure.message.includes('回执')) active = null;
          updateAvailability();
        }
      },
      true
    );
    cancel.addEventListener(
      'click',
      async (event) => {
        if (!active) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (active.uncertain) return;
        cancel.disabled = true;
        try {
          await appleRequest(
            active.batchId ? 'cancel-batch' : 'cancel-task',
            active.batchId ? { batchId: active.batchId } : { taskUuid: active.taskUuid }
          );
          log('取消请求已提交，等待原任务停止；结果未知的邮箱仍需核对。');
          void poll();
        } catch (failure) {
          error.textContent = failure.message;
          updateAvailability();
        }
      },
      true
    );
    service.addEventListener('change', () => {
      updateAvailability();
      if (selected()) void loadOptions();
    });
    mode.addEventListener('change', updateAvailability);
    targets.addEventListener('change', () => {
      const chosen = new Set([...targets.selectedOptions].map((item) => item.value));
      values['id-apple-picked'] = JSON.stringify([...chosen]);
      emitDraft();
    });
    refresh.addEventListener('click', () => {
      void loadOptions();
      if (active) void poll();
    });
    window.addEventListener('pagehide', () => {
      disposed = true;
      observer.disconnect();
      generation++;
      progressGeneration++;
      clearTimeout(progressTimer);
    });
    window.addEventListener('message', (event) => {
      if (
        event.source !== parent ||
        event.origin !== location.origin ||
        event.data?.type !== 'id-registration:state'
      )
        return;
      const stored = event.data.draft?.['storage:appleTask'];
      if (!active && typeof stored === 'string') {
        try {
          const restored = JSON.parse(stored);
          if (typeof restored.taskUuid === 'string' || typeof restored.batchId === 'string') {
            active = restored;
            updateAvailability();
            void poll();
          }
        } catch {
          /* Invalid ordinary draft cannot start or resume a task. */
        }
      }
      updateAvailability();
      if (selected() && !optionsReady) void loadOptions();
    });
    updateAvailability();
  }

  window.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('input', captureDraft);
    document.addEventListener('change', captureDraft);
    window.addEventListener('pagehide', captureDraft);
    if (page === '/') installAppleConsole();
    if (pendingState) applyState(pendingState);
    parent.postMessage({ type: 'id-registration:ready', page }, location.origin);
  });
})();
