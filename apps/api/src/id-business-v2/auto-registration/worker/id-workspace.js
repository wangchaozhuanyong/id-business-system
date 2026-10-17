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
      !field.disabled &&
      field.dataset.v2DraftPending !== 'true'
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
      this.events.onmessage = (event) => {
        const raw = JSON.parse(event.data);
        let message = raw;
        if (typeof raw === 'string') {
          try {
            message = JSON.parse(raw);
          } catch {
            /* Preserve the upstream frame. */
          }
        }
        if (message?.type === 'status') {
          const notice = new CustomEvent('id-registration:task-progress', {
            cancelable: true,
            detail: { path: this.path, status: message.status }
          });
          const forward = window.dispatchEvent(notice);
          // Upstream treats cancelling as terminal; only a final task readback may close the task.
          if (!forward || message.status === 'cancelling') return;
        }
        this.onmessage?.({ data: raw });
      };
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

  function registrationFlowEvidenceRows(value) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('version' in value) ||
      (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4)
    )
      return [];
    const evidence = value;
    const label = (labels, item, fallback) =>
      typeof item === 'string' && Object.hasOwn(labels, item) ? labels[item] : fallback;

    if (evidence.version === 4) {
      const rows = [];
      const summary = evidence.configurationSummary;
      const config =
        summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : {};
      const matches = (item) =>
        item === true ? '与原版一致' : item === false ? '与原版不同' : '未记录';
      rows.push({
        stage: 'configuration',
        title: '本次配置核对',
        status: '仅显示核对结果，不显示配置值',
        detail: [
          `客户端标识：${matches(config.clientIdMatchesFrozenDefault)}`,
          `授权入口：${matches(config.authUrlMatchesFrozenDefault)}`,
          `授权凭据入口：${matches(config.tokenUrlMatchesFrozenDefault)}`,
          `回调地址：${matches(config.redirectUriMatchesFrozenDefault)}`,
          `授权范围：${matches(config.scopeMatchesFrozenDefault)}`,
          config.proxyPresent === true
            ? '注册代理：已配置'
            : config.proxyPresent === false
              ? '注册代理：未配置'
              : '注册代理：未记录',
          label(
            {
              default: '代理来源：系统默认',
              system: '代理来源：代理目录',
              explicit: '代理来源：手工配置',
              not_recorded: '代理来源：未记录'
            },
            config.proxySource,
            '代理来源：待核对'
          )
        ].join(' · ')
      });
      const attempts = Array.isArray(evidence.attempts) ? evidence.attempts.slice(-32) : [];
      if (
        evidence.attemptsTruncated === true ||
        (Array.isArray(evidence.attempts) && evidence.attempts.length > 32)
      )
        rows.push({
          stage: 'truncated',
          title: '较早请求已省略',
          status: '仅保留最近 32 次请求',
          detail: '以下保留原请求序号；首次失败仍以上方任务记录为准。'
        });
      for (const [index, candidate] of attempts.entries()) {
        const attempt =
          candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
        const stage =
          typeof attempt.stage === 'string' &&
          ['authorize', 'sentinel', 'signup', 'password'].includes(attempt.stage)
            ? attempt.stage
            : '';
        const sequence =
          Number.isSafeInteger(attempt.sequence) && attempt.sequence > 0
            ? `第 ${attempt.sequence} 次`
            : '请求序号待核对';
        const observation =
          attempt.outcome === 'response' && stage
            ? registrationFlowEvidenceRows({ version: 3, [stage]: attempt.observation }).find(
                (row) => row.stage === stage
              )
            : null;
        const presence = (item) =>
          label({ present: '存在', absent: '不存在', not_observed: '未检查' }, item, '待核对');
        rows.push({
          stage: 'attempt-' + index,
          title:
            sequence +
            ' · ' +
            label(
              {
                authorize: '授权入口',
                sentinel: '注册前置校验',
                signup: '提交注册邮箱',
                password: '提交注册密码'
              },
              stage,
              '请求阶段待核对'
            ),
          status:
            attempt.outcome === 'response'
              ? attempt.responseClass === 'verification_required' ||
                attempt.responseClass === 'structured_rejection' ||
                attempt.responseClass === 'rate_limited'
                ? '已停止，等待核对'
                : attempt.responseClass === 'unclassified'
                  ? observation?.status || '响应待核对'
                  : '响应判断待核对'
              : label(
                  { network_error: '网络请求失败', evidence_storage_error: '流程证据保存失败' },
                  attempt.outcome,
                  '执行结果待核对'
                ),
          detail: [
            attempt.outcome === 'response'
              ? observation?.detail || '未取得可核对的响应证据'
              : label(
                  {
                    network_error: '本次未取得响应，不能沿用上一次响应判断结果',
                    evidence_storage_error: '本次流程证据未能保存，执行已停止'
                  },
                  attempt.outcome,
                  '本次执行资料待核对'
                ),
            label(
              {
                verification_required: '响应判断：官网要求额外验证',
                structured_rejection: '响应判断：官网明确拒绝',
                rate_limited: '响应判断：请求受到限制',
                unclassified: '响应判断：尚未归类',
                not_applicable: '响应判断：无响应可供判断'
              },
              attempt.responseClass,
              '响应判断：待核对'
            ),
            `设备标记：请求前${presence(attempt.deviceCookieBefore)}，请求后${presence(attempt.deviceCookieAfter)}`
          ].join(' · ')
        });
      }
      if (!attempts.length)
        rows.push({
          stage: 'attempts-empty',
          title: '请求过程尚未记录',
          status: '暂无请求观察',
          detail: '请以上方实际失败步骤为准，不推断已进入授权入口或提交密码。'
        });
      return rows;
    }

    return [
      ['authorize', '授权入口'],
      ...(evidence.version === 3 ? [['sentinel', '注册前置校验']] : []),
      ['signup', '提交注册邮箱'],
      ['password', '提交注册密码']
    ].map(([stage, title]) => {
      const candidate = evidence[stage];
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
        return { stage, title, status: '尚未观察', detail: '尚未取得该阶段的流程证据' };
      const row = candidate;
      const status = label(
        {
          accepted: '已确认继续',
          rejected: '已停止，等待核对',
          observed: '已观察，不代表注册成功'
        },
        row.decision,
        '观察结果待核对'
      );
      const details = [
        Number.isInteger(row.httpStatus) &&
        Number(row.httpStatus) >= 100 &&
        Number(row.httpStatus) <= 599
          ? `响应状态 ${row.httpStatus}`
          : '未取得响应状态',
        row.officialOrigin === true ? '官网来源已确认' : '官网来源未确认',
        label(
          {
            json: '响应类型：结构化数据',
            html: '响应类型：网页',
            other: '响应类型：其他',
            missing: '响应类型：未记录'
          },
          row.contentType,
          '响应类型：待核对'
        ),
        label(
          {
            object: '数据结构：对象',
            other: '数据结构：非对象',
            invalid: '数据结构：解析失败',
            not_checked: '数据结构：未检查'
          },
          row.jsonKind,
          '数据结构：待核对'
        ),
        label(
          {
            new_account: '页面类型：新账号注册',
            existing_account: '页面类型：已有账号',
            missing: '页面类型：缺失',
            unknown: '页面类型：未知',
            not_checked: '页面类型：未检查'
          },
          row.pageKind,
          '页面类型：待核对'
        )
      ];
      if (row.reason !== null) {
        details.push(
          label(
            {
              http_status: '响应状态不符合预期',
              untrusted_origin: '来源未通过校验',
              invalid_json: '响应不是预期的结构化数据',
              upstream_error: '官网响应携带错误',
              unexpected_page: '页面类型与预期不符',
              challenge_required: '官网要求额外验证，当前流程已停止',
              challenge_invalid: '官网验证要求无法确认',
              missing_token: '未取得官网验证凭据'
            },
            row.reason,
            '判断原因待核对'
          )
        );
      }
      if (
        ((evidence.version === 2 && stage === 'signup') ||
          (evidence.version === 3 && (stage === 'signup' || stage === 'password'))) &&
        row.responseDetails &&
        typeof row.responseDetails === 'object' &&
        !Array.isArray(row.responseDetails)
      ) {
        const response = row.responseDetails;
        const shapes = {
          missing: '未提供',
          null: '空值',
          object: '对象',
          string: '文本',
          list: '列表',
          boolean: '布尔值',
          number: '数字',
          other: '其他'
        };
        details.push(
          label(
            {
              none: '响应错误：未携带错误',
              error: '响应错误：携带单项错误',
              errors: '响应错误：携带错误集合',
              both: '响应错误：同时携带两类错误'
            },
            response.errorSignal,
            '响应错误：待核对'
          ),
          `单项错误结构：${label(shapes, response.errorShape, '待核对')}`,
          `错误集合结构：${label(shapes, response.errorsShape, '待核对')}`,
          label(
            {
              none: '上游错误分类：无',
              account_creation_failed: '上游错误分类：拒绝创建账号',
              user_exists: '上游错误分类：账号已存在',
              other: '上游错误分类：其他'
            },
            response.errorKind,
            '上游错误分类：待核对'
          )
        );
        if (stage === 'signup') {
          details.push(
            label(
              {
                missing: '页面结构异常：未提供页面信息',
                non_object: '页面结构异常：页面信息不是对象',
                type_missing: '页面结构异常：缺少页面类型',
                type_non_string: '页面结构异常：页面类型不是文本',
                type_known: '页面结构：类型已识别',
                type_unknown: '未知页面：类型尚未识别'
              },
              response.pageShape,
              '页面结构：待核对'
            )
          );
        }
        if (evidence.version === 3 && response.pageShape === 'type_unknown') {
          details.push(
            typeof response.pageTypeSha256 === 'string' &&
              /^[a-f0-9]{64}$/.test(response.pageTypeSha256)
              ? '未知页面标识摘要已记录'
              : '未知页面标识摘要未记录'
          );
        }
      }
      if (evidence.version === 3 && stage === 'password' && row.pageKind === 'missing') {
        details[4] = '此阶段未要求页面类型';
      }
      if (
        evidence.version === 3 &&
        stage === 'sentinel' &&
        row.sentinelDetails &&
        typeof row.sentinelDetails === 'object' &&
        !Array.isArray(row.sentinelDetails)
      ) {
        const challenge = row.sentinelDetails;
        const required = {
          required: '官网要求',
          not_required: '官网未要求',
          missing: '官网未说明',
          invalid: '要求格式无效'
        };
        details.push(
          challenge.tokenPresent === true
            ? '官网验证凭据：已取得'
            : challenge.tokenPresent === false
              ? '官网验证凭据：未取得'
              : '官网验证凭据：待核对',
          `额外计算验证：${label(required, challenge.proofOfWorkRequired, '待核对')}`,
          `交互验证：${label(required, challenge.turnstileRequired, '待核对')}`
        );
      }
      if (Array.isArray(row.redirectHosts) && row.redirectHosts.length) {
        const hosts = row.redirectHosts.slice(0, 5).map((host) =>
          label(
            {
              auth_openai: '官网授权服务',
              sentinel_openai: '官网安全服务',
              chatgpt: '官网账号服务',
              other: '其他来源'
            },
            host,
            '来源待核对'
          )
        );
        details.push(
          `跳转来源：${hosts.join('、')}${row.redirectsTruncated === true ? '（仅记录前段）' : ''}`
        );
      }
      details.push(row.requestIdPresent === true ? '请求标识已记录' : '未记录请求标识');
      return { stage, title, status, detail: details.join(' · ') };
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
    let fieldEnter = false;
    let enterTimer;
    let genericCancellation = null;
    let genericTimer;
    let genericGeneration = 0;
    let genericEvidenceGeneration = 0;
    let genericEvidenceRequest = 0;
    const group = document.createElement('div');
    group.id = 'id-apple-console';
    group.hidden = true;
    group.innerHTML =
      '<div class="form-group"><label for="id-apple-choice">注册邮箱</label><select id="id-apple-choice" data-v2-draft-pending="true"><option value="">自动选择一个未注册邮箱</option></select></div>' +
      '<div class="form-group" id="id-apple-batch-group" hidden><label for="id-apple-targets">批量邮箱</label><select id="id-apple-targets" multiple size="5" aria-label="指定批量注册邮箱"></select><small>未选择时按数量从可用未注册邮箱中选取；可以选择部分邮箱。</small></div>' +
      '<div class="form-group"><label for="id-system-route">注册代理</label><select id="id-system-route" data-v2-draft-pending="true"><option value="">沿用原系统设置的代理</option></select></div>' +
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
    const flowPanel = document.createElement('section');
    flowPanel.id = 'id-apple-flow-evidence';
    flowPanel.className = 'card-body';
    flowPanel.hidden = true;
    flowPanel.setAttribute('aria-label', '注册流程观察');
    document.getElementById('task-status-row')?.after(flowPanel);
    function renderFlowEvidence(tasks) {
      flowPanel.replaceChildren();
      for (const [index, task] of tasks.entries()) {
        const rows = registrationFlowEvidenceRows(task.flowEvidence);
        if (!rows.length) continue;
        const title = document.createElement('strong');
        title.textContent =
          (task.flowEvidence?.version === 4 ? '注册请求过程与配置核对' : '注册流程观察') +
          (tasks.length > 1 ? ' · 任务 ' + (index + 1) : '');
        flowPanel.appendChild(title);
        const note = document.createElement('p');
        note.textContent =
          '以下观察只说明请求处理经过，账号创建、身份核验和同步结果以任务记录为准。';
        flowPanel.appendChild(note);
        const list = document.createElement('ol');
        for (const row of rows) {
          const item = document.createElement('li');
          const label = document.createElement('strong');
          label.textContent = row.title + ' · ' + row.status;
          const detail = document.createElement('p');
          detail.textContent = row.detail;
          item.append(label, detail);
          list.appendChild(item);
        }
        flowPanel.appendChild(list);
      }
      flowPanel.hidden = flowPanel.children.length === 0;
    }
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
      if (genericCancellation) {
        start.disabled = true;
        cancel.disabled = genericCancellation.accepted || genericCancellation.submitting;
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
        // Upstream rebuilds the service selector asynchronously and emits change.
        // Its empty candidate controls must not replace the shared session draft.
        delete choice.dataset.v2DraftPending;
        delete route.dataset.v2DraftPending;
        captureDraft();
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
    function logTaskFailure(task) {
      const failure = task.record?.firstFailure;
      if (failure) {
        const stages = {
          queued: '注册初始化',
          ip_check: '注册出口检查',
          mailbox: '准备注册邮箱',
          initialization: '注册初始化',
          authorize: '授权入口',
          sentinel: '注册前置校验',
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
          evidence_storage_error: '流程证据保存失败',
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
    }
    function genericTaskState() {
      try {
        const stored = JSON.parse(storage.get('activeTask') || 'null');
        if (!stored || !['single', 'batch', 'outlook_batch'].includes(stored.mode)) return null;
        const id = stored.mode === 'single' ? stored.task_uuid : stored.batch_id;
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return null;
        return {
          ...stored,
          id,
          endpoint:
            stored.mode === 'single'
              ? '/api/registration/tasks/' + id
              : '/api/registration/' +
                (stored.mode === 'outlook_batch' ? 'outlook-batch/' : 'batch/') +
                id
        };
      } catch {
        return null;
      }
    }
    function showCancellationPending() {
      for (const id of ['task-status', 'task-status-badge']) {
        const node = document.getElementById(id);
        if (node)
          node.textContent =
            id === 'task-status-badge' ? '等待停止' : '取消请求已受理，等待任务停止';
      }
      start.disabled = true;
      cancel.disabled = true;
    }
    function refreshGenericEvidence(state) {
      if (state.mode !== 'single') return;
      const generation = genericEvidenceGeneration;
      const request = ++genericEvidenceRequest;
      void appleRequest('task', { taskUuid: state.id })
        .then((task) => {
          const current = genericTaskState();
          if (
            disposed ||
            generation !== genericEvidenceGeneration ||
            request !== genericEvidenceRequest ||
            (current && current.id !== state.id) ||
            task?.taskUuid !== state.id
          )
            return;
          renderFlowEvidence([task]);
          logTaskFailure(task);
        })
        .catch(() => {
          // Unbound or unavailable facts cannot replace the original task's actual terminal status.
        });
    }
    async function pollGenericCancellation() {
      if (disposed || !genericCancellation) return;
      clearTimeout(genericTimer);
      const snapshot = genericCancellation;
      const generation = ++genericGeneration;
      try {
        const response = await window.fetch(snapshot.endpoint);
        if (!response.ok) throw new Error('task readback failed');
        const data = await response.json();
        if (disposed || genericCancellation !== snapshot || generation !== genericGeneration)
          return;
        const status = Object.hasOwn(taskLabels, data.status) ? data.status : null;
        const final = status && !['pending', 'running'].includes(status);
        refreshGenericEvidence(snapshot);
        const finishedBatch = snapshot.mode !== 'single' && data.finished === true;
        if (final || finishedBatch) {
          genericCancellation = null;
          genericGeneration++;
          if (typeof window.resetButtons === 'function') window.resetButtons();
          else {
            start.disabled = false;
            cancel.disabled = true;
            memoryStorage.removeItem('activeTask');
          }
          if (
            final &&
            ['completed', 'failed', 'cancelled'].includes(status) &&
            typeof window.updateTaskStatus === 'function'
          )
            window.updateTaskStatus(status);
          for (const id of ['task-status', 'task-status-badge']) {
            const node = document.getElementById(id);
            if (node)
              node.textContent =
                id === 'task-status-badge'
                  ? final
                    ? {
                        completed: '已结束',
                        failed: '失败',
                        cancelled: '已取消',
                        interrupted: '待核对',
                        awaiting_review: '待核对'
                      }[status]
                    : '待核对'
                  : final
                    ? taskLabels[status]
                    : '批量任务已结束，取消结果需核对';
          }
          log(`任务实际结果：${final ? taskLabels[status] : '批量任务已结束，取消结果需核对'}`);
          if (typeof window.loadRecentAccounts === 'function') void window.loadRecentAccounts();
          return;
        }
        // A batch's finished flag without a controlled terminal status never claims cancellation.
        if (snapshot.accepted) showCancellationPending();
        else {
          start.disabled = true;
          cancel.disabled = snapshot.submitting === true;
        }
      } catch {
        if (disposed || genericCancellation !== snapshot || generation !== genericGeneration)
          return;
        error.textContent = '任务状态尚未核对，不能确认已取消；正在继续读取原任务。';
        log(error.textContent, 'error');
        start.disabled = true;
      }
      if (!disposed && genericCancellation === snapshot)
        genericTimer = setTimeout(pollGenericCancellation, 2500);
    }
    async function cancelGenericTask(state) {
      if (genericCancellation?.accepted || genericCancellation?.submitting) return;
      const snapshot = { ...state, submitting: true, accepted: false };
      genericCancellation = snapshot;
      if (typeof window.stopLogPolling === 'function') window.stopLogPolling();
      if (typeof window.stopBatchPolling === 'function') window.stopBatchPolling();
      start.disabled = true;
      cancel.disabled = true;
      error.textContent = '';
      try {
        const response = await window.fetch(state.endpoint + '/cancel', { method: 'POST' });
        if (!response.ok) throw new Error('cancel not acknowledged');
        if (disposed || genericCancellation !== snapshot) return;
        snapshot.accepted = true;
        memoryStorage.setItem(
          'activeTask',
          JSON.stringify({ ...state, cancellationRequested: true })
        );
        log('取消请求已受理，等待原任务停止；尚未确认已取消。');
        showCancellationPending();
      } catch {
        if (disposed || genericCancellation !== snapshot) return;
        error.textContent = '取消请求未确认，正在核对原任务；请勿重新注册。';
        log(error.textContent, 'error');
        cancel.disabled = false;
      } finally {
        snapshot.submitting = false;
      }
      if (!disposed && genericCancellation === snapshot) void pollGenericCancellation();
    }
    window.addEventListener('id-registration:task-progress', (event) => {
      const state = genericCancellation || genericTaskState();
      if (!state || active) return;
      const expected = state.mode === 'single' ? '/api/ws/task/' : '/api/ws/batch/';
      if (event.detail?.path !== expected + state.id) return;
      if (event.detail.status === 'cancelling' && !genericCancellation) {
        genericCancellation = { ...state, accepted: true };
        showCancellationPending();
      }
      if (genericCancellation) {
        event.preventDefault();
        void pollGenericCancellation();
      } else if (
        state.mode === 'single' &&
        [
          'pending',
          'running',
          'completed',
          'failed',
          'cancelled',
          'interrupted',
          'awaiting_review'
        ].includes(event.detail.status)
      ) {
        refreshGenericEvidence(state);
      }
    });
    form.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Enter' || event.isComposing) return;
        if (event.target === start) {
          fieldEnter = false;
          clearTimeout(enterTimer);
          return;
        }
        if (event.target?.closest?.('textarea,[contenteditable="true"]')) return;
        fieldEnter = true;
        clearTimeout(enterTimer);
        enterTimer = setTimeout(() => {
          fieldEnter = false;
        }, 0);
      },
      true
    );
    start.addEventListener(
      'click',
      (event) => {
        if (event.detail > 0 || document.activeElement === start) {
          fieldEnter = false;
          clearTimeout(enterTimer);
        }
      },
      true
    );
    form.addEventListener(
      'submit',
      (event) => {
        if (fieldEnter || event.submitter !== start || genericCancellation || active) {
          event.preventDefault();
          event.stopImmediatePropagation();
        } else if (!selected()) {
          genericEvidenceGeneration++;
          renderFlowEvidence([]);
        }
      },
      true
    );
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
        renderFlowEvidence(tasks);
        let running = false;
        for (const task of tasks) {
          (task.logs || []).forEach((line) => log(line));
          const syncStatus = task.record?.syncStatus || task.syncStatus;
          log(
            `${taskLabels[task.status] || '等待核对'}${syncStatus ? ` · ${syncLabels[syncStatus] || '同步状态待核对'}` : ''}`
          );
          logTaskFailure(task);
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
          renderFlowEvidence([]);
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
        if (!active) {
          const state = genericCancellation || genericTaskState();
          if (!state) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          void cancelGenericTask(state);
          return;
        }
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
      if (genericCancellation) void pollGenericCancellation();
    });
    window.addEventListener('pagehide', () => {
      disposed = true;
      observer.disconnect();
      generation++;
      progressGeneration++;
      clearTimeout(progressTimer);
      genericGeneration++;
      genericEvidenceGeneration++;
      clearTimeout(genericTimer);
      clearTimeout(enterTimer);
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
      const generic = genericTaskState();
      if (!active && !genericCancellation && generic?.cancellationRequested) {
        genericCancellation = { ...generic, accepted: true };
        showCancellationPending();
        void pollGenericCancellation();
      }
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
