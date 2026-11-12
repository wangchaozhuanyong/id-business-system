(function () {
  const origin = window.location.origin;
  const standalone = window.parent === window;
  const root = document.documentElement;
  const search = new URLSearchParams(window.location.search);
  const taskLog = search.get('taskLog');
  const telegramSettings = !standalone && window.location.pathname.endsWith('/admin') &&
    search.get('section') === 'telegram' && !taskLog;
  if (telegramSettings) root.dataset.rechargeTelegram = 'loading';
  if (!standalone && window.location.pathname.endsWith('/admin') && /^[\w-]{1,128}$/.test(taskLog ?? '')) {
    root.dataset.rechargeTaskLog = '';
    window.idRechargeTaskLog = taskLog;
  }
  root.dataset.rechargeNavigationLocked = 'false';
  let reportType = '';
  let updateTableLayout;
  let syncWorkspaceViewport;
  let telegramStatus;
  window.idRechargeVisible = standalone;
  function setVisible(visible) {
    window.idRechargeVisible = visible;
    if (!visible && root.dataset.rechargeNavigationLocked !== 'true') {
      window.idRechargeClearTransient?.();
      for (const input of document.querySelectorAll('input[type="password"], #checkout_session_input, #tokenInput, #cdkInput, #queryInput, #batchQueryInput')) {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    if (visible && reportType === 'ready') {
      report('view-context');
      report('resize');
    }
  }
  let restoreDrafts = () => {};
  if (!standalone) syncTheme();

  function setupWorkspaceViewport() {
    const workspace = document.body.hasAttribute('data-recharge-workspace');
    const frame = window.frameElement;
    const embedded = frame?.classList.contains('recharge-integration__frame');
    if (!embedded && !workspace) return;
    const host = frame?.ownerDocument.defaultView || window;
    const sync = () => {
      if (embedded && !frame.getClientRects().length) return;
      // The budget belongs to the host so reporting the iframe height cannot enlarge it.
      const available = embedded
        ? host.IDPagination?.workspaceViewportHeight?.(frame) : host.innerHeight;
      if (embedded && !Number.isFinite(available)) return;
      root.toggleAttribute('data-recharge-viewport', embedded === true);
      const value = (workspace ? Math.max(640, available) : available) + 'px';
      if (root.style.getPropertyValue('--workspace-available-height') !== value)
        root.style.setProperty('--workspace-available-height', value);
    };
    sync();
    host.addEventListener('resize', sync);
    const observer = new ResizeObserver(sync);
    if (embedded) {
      const toolbar = frame.closest('.recharge-integration')?.querySelector('.recharge-integration__toolbar');
      const footer = frame.closest('main')?.nextElementSibling;
      if (toolbar) observer.observe(toolbar);
      if (footer?.matches('.workspace-footer')) observer.observe(footer);
    }
    window.addEventListener('pagehide', event => {
      if (event.persisted) return;
      host.removeEventListener('resize', sync);
      observer.disconnect();
    });
    return sync;
  }

  function setupWorkspaceLog() {
    const viewport = document.getElementById('workspaceLogViewport');
    const entries = document.getElementById('workspaceLogEntries');
    const empty = document.getElementById('workspaceLogEmpty');
    const follow = document.getElementById('workspaceLogFollow');
    const latest = document.getElementById('workspaceLogLatest');
    const refresh = document.getElementById('workspaceLogRefresh');
    const status = document.getElementById('workspaceLogStatus');
    const clock = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    let state = 'idle', busy = false, offline = false, lastEntry = '', updated = '', stepsAvailable;
    let followFrame;
    const recordedSteps = new Set();
    const sourceLabels = { page: '本页', receipt: '状态回执', execution: '执行事件' };
    let latestStep;
    const renderStatus = () => {
      refresh.disabled = state !== 'running' || busy;
      refresh.textContent = busy ? '刷新中…' : '刷新';
      if (offline) status.textContent = '连接中断，正在重连';
      else if (state === 'running' || state === 'finished') {
        const statusText = state === 'running' ? '自动更新中' : '更新已结束';
        const stepsHint = stepsAvailable === false ? ' · 执行记录暂不可读' :
          state === 'running' && stepsAvailable === true && !recordedSteps.size ? ' · 等待执行事件' : '';
        status.textContent = statusText + (updated ? ' · ' + updated : '') + stepsHint;
      } else status.textContent = {
        idle: '等待验证兑换码', verifying: '正在验证兑换码', verified: '兑换码已验证，等待提交',
        submitting: '正在确认提交结果', uncertain: '提交结果待核对'
      }[state];
    };
    const scrollLatest = () => {
      if (viewport.clientHeight) viewport.scrollTop = viewport.scrollHeight;
    };
    const followLatest = () => {
      if (!follow.checked) return;
      scrollLatest();
      if (followFrame !== undefined) return;
      followFrame = requestAnimationFrame(() => {
        followFrame = undefined;
        if (follow.checked) scrollLatest();
      });
    };
    const setFollow = (enabled) => {
      follow.checked = enabled;
      latest.hidden = enabled;
      if (enabled) followLatest();
    };
    follow.addEventListener('change', () => setFollow(follow.checked));
    latest.addEventListener('click', () => setFollow(true));
    viewport.addEventListener('scroll', () => {
      if (follow.checked && viewport.clientHeight && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 24)
        setFollow(false);
    }, { passive: true });
    const resize = new ResizeObserver(followLatest);
    resize.observe(viewport);
    window.addEventListener('pagehide', event => { if (!event.persisted) resize.disconnect(); });
    refresh.addEventListener('click', () => window.idRechargeRefreshTask?.());
    const validTime = at => Number.isSafeInteger(at) && at > 0 && at <= 8.64e15;
    const append = (text, tone, at, source) => {
      empty.hidden = true;
      const entry = document.createElement('li');
      entry.dataset.tone = tone;
      entry.dataset.eventSource = source;
      const instant = validTime(at) ? at : Date.now();
      entry.dataset.at = String(instant);
      const time = document.createElement('time');
      const date = new Date(instant);
      time.dateTime = date.toISOString();
      time.textContent = clock.format(date);
      const origin = document.createElement('span');
      origin.className = 'workspace-log-origin';
      origin.textContent = sourceLabels[source];
      entry.append(time, document.createTextNode('  '), origin, document.createTextNode('  ' + text));
      const following = [...entries.children].find(child => Number(child.dataset.at) > instant);
      const top = following?.getBoundingClientRect().top;
      const preservePosition = !follow.checked && viewport.scrollTop > 0 && top < viewport.getBoundingClientRect().top;
      entries.insertBefore(entry, following || null);
      if (preservePosition) viewport.scrollTop += following.getBoundingClientRect().top - top;
    };
    const record = (text, tone = 'running', at, source = 'page') => {
      const signature = source + ':' + tone + ':' + text;
      if (!text || signature === lastEntry) return;
      lastEntry = signature;
      append(text, tone, at, source);
      followLatest();
    };
    const workspaceLog = {
      record,
      receipt(text, tone, at) { record(text, tone, at, validTime(at) ? 'execution' : 'receipt'); },
      beginSubmission() {
        if (state === 'finished') {
          workspaceLog.reset();
          workspaceLog.receipt('本次提交使用已验证的兑换码。');
        }
        workspaceLog.state('submitting');
        record('账号资料格式检查通过。');
        record('正在提交，等待服务确认。');
      },
      syncSteps(steps, labels) {
        let added = false;
        for (const step of Array.isArray(steps) ? steps.slice(-160) : []) {
          if (!step || !Object.hasOwn(labels, step.stage) || !validTime(step.at)) continue;
          const attempt = Number.isSafeInteger(step.attempt) && step.attempt > 0 && step.attempt <= 999 ? step.attempt : '';
          const query = Number.isSafeInteger(step.query) && step.query > 0 && step.query <= 999999 ? step.query : '';
          const id = Number.isSafeInteger(step.id) && step.id > 0 ? step.id : '';
          const key = [step.stage, step.at, attempt, query, id].join(':');
          if (recordedSteps.has(key)) continue;
          recordedSteps.add(key);
          const label = labels[step.stage];
          const detail = attempt ? '第 ' + attempt + ' 次尝试 · ' : query ? '第 ' + query + ' 次查询 · ' : '';
          const tone = ['worker_retry', 'card_retry', 'payment_decline_detected', 'provider_query_failed'].includes(step.stage)
            ? 'review' : 'running';
          append(detail + label, tone, step.at, 'execution');
          added = true;
          if (!latestStep || step.at >= latestStep.at) latestStep = { label, at: step.at };
        }
        if (added) {
          followLatest();
          renderStatus();
        }
        return latestStep?.label;
      },
      reset() {
        entries.replaceChildren();
        empty.hidden = false;
        recordedSteps.clear();
        latestStep = undefined;
        state = 'idle'; busy = false; offline = false; lastEntry = ''; updated = ''; stepsAvailable = undefined;
        setFollow(true);
        renderStatus();
      },
      state(value) { state = value; renderStatus(); },
      refreshing(value) { busy = value; renderStatus(); },
      connected(available) {
        if (offline) record('连接已恢复，继续更新任务状态。', 'running', undefined, 'receipt');
        if (stepsAvailable === false && available === true)
          record('执行记录读取已恢复。', 'running', undefined, 'receipt');
        offline = false;
        stepsAvailable = available;
        updated = clock.format(new Date());
        renderStatus();
      },
      disconnected() {
        if (!offline) record('连接暂时中断，已保留记录，正在重新连接。', 'review');
        offline = true;
        renderStatus();
      }
    };
    window.idRechargeWorkspaceLog = workspaceLog;
    window.IDTitleHelp.attach(document.getElementById('workspace-log-title'), document.getElementById('workspace-log-help'));
  }

  function syncTheme(theme) {
    try {
      const host = window.parent.document.documentElement;
      root.dataset.idTheme = theme || (host.dataset.theme === 'dark' ? 'dark' : 'light');
      const style = window.parent.getComputedStyle(host);
      for (const name of [
        'bg',
        'surface',
        'surface-soft',
        'text',
        'secondary',
        'muted',
        'line',
        'primary',
        'primary-hover',
        'primary-soft',
        'danger',
        'danger-soft',
        'warning',
        'warning-soft',
        'blue',
        'blue-soft',
        'radius',
        'shadow'
      ]) {
        root.style.setProperty('--host-' + name, style.getPropertyValue('--' + name));
      }
    } catch {
      // Standalone and failed host reads retain the module theme.
    }
  }

  function report(type) {
    if (type === 'ready') restoreDrafts();
    if (type === 'ready' || type === 'view-context') {
      syncWorkspaceViewport?.();
      updateTableLayout?.();
    }
    if (type !== 'resize' && type !== 'view-context') {
      reportType = type;
      if (telegramSettings) {
        root.dataset.rechargeTelegram = type;
        updateTelegramStatus();
      }
    }
    if (standalone) return;
    const context = type === 'ready' || type === 'view-context';
    window.parent.postMessage(
      {
        source: 'id-codexdaichong',
        type,
        height: document.body.offsetHeight,
        ...(context ? { description: viewDescription() } : {})
      },
      origin
    );
  }

  function viewDescription() {
    if (document.body.hasAttribute('data-recharge-query')) return '支持单个或批量查询兑换码。';
    return document.querySelector('.page-view.active > .page-header > p')?.textContent.trim() || '';
  }

  window.idRechargeReport = report;
  window.idRechargeOpenTaskLog = (jobKey) => {
    if (standalone || !jobKey || !/^[\w-]{1,128}$/.test(jobKey)) return false;
    window.parent.postMessage({ source: 'id-codexdaichong', type: 'open-task-log', jobKey }, origin);
    return true;
  };
  window.idRechargeSetNavigationLock = (locked) => {
    const next = String(locked === true);
    if (root.dataset.rechargeNavigationLocked === next) return;
    root.dataset.rechargeNavigationLocked = next;
    if (!standalone) {
      window.parent.postMessage(
        { source: 'id-codexdaichong', type: 'navigation-lock', locked: locked === true },
        origin
      );
    }
  };
  window.idRechargeSelect = (view) => {
    if (typeof view !== 'string' || !/^[a-z_]+$/.test(view)) return;
    if (document.body.dataset.rechargeView === 'admin') {
      const nav = [...document.querySelectorAll('.nav-item[onclick]')].find((item) =>
        item.getAttribute('onclick').startsWith("switchPage('" + view + "',")
      );
      nav?.click();
      return;
    }
    if (['query', 'redeem'].includes(view) ||
        (view === 'guide' && document.body.hasAttribute('data-recharge-workspace'))) {
      if (document.body.dataset.rechargeView === 'subscription') {
        window.location.replace('/integrations/codexdaichong/redeem?tab=' + view);
        return;
      }
      const tab = document.querySelector('[data-tab="' + view + '"]');
      if (tab && !tab.classList.contains('active')) tab.click();
    }
  };
  window.addEventListener('message', (event) => {
    if (event.origin !== origin || event.source !== window.parent) return;
    const message = event.data;
    if (message?.source !== 'id-recharge-shell') return;
    if (message.type === 'theme' && ['light', 'dark'].includes(message.theme)) {
      syncTheme(message.theme);
    } else if (message.type === 'visibility' && typeof message.visible === 'boolean') {
      setVisible(message.visible);
    } else if (message.type === 'select-view') {
      window.idRechargeSelect(message.view);
    } else if (!standalone && message.type === 'data-change' && Array.isArray(message.scopes)) {
      if (message.scopes.includes('card-types')) window.idRechargeCardTypesChanged?.();
      if (message.scopes.includes('recharge-card-plans'))
        window.idRechargeCardPlansChanged?.(message.cardPlanVersion);
    }
  });

  function styleAdminLayout() {
    for (const table of document.querySelectorAll('table.data-table')) {
      const container = table.parentElement;
      if (container && !container.classList.contains('table-container'))
        container.classList.add('table-container');
    }
    for (const group of document.querySelectorAll('.form-group')) {
      const label = group.querySelector(':scope > label:first-child');
      if (!label) continue;
      group.classList.add('embedded-field');
      const fields = group.querySelectorAll('input:not([type="hidden"]), select, textarea');
      if (!label.htmlFor && fields.length === 1 && fields[0].id) label.htmlFor = fields[0].id;
    }
    for (const group of document.querySelectorAll('.panel-header > div:has(> button)'))
      group.classList.add('table-toolbar-actions');
    const cdkSearch = document.getElementById('cdk_search');
    if (cdkSearch) {
      const actions = cdkSearch.parentElement;
      const filters = document.createElement('div');
      filters.className = 'table-toolbar-filters';
      filters.append(
        cdkSearch,
        ...document.querySelectorAll('#cdks .batch-actions .filter-dropdown')
      );
      actions.before(filters);
    }
    const viewChanges = new MutationObserver(() => {
      if (reportType === 'ready') report('view-context');
    });
    for (const view of document.querySelectorAll('.page-view'))
      viewChanges.observe(view, { attributes: true, attributeFilter: ['class'] });
  }

  function setupRechargeCellText() {
    let dialog;
    document.addEventListener('click', (event) => {
      const preview = event.target.closest('.recharge-cell-text');
      if (!preview) return;
      if (!dialog) {
        dialog = document.createElement('dialog');
        dialog.className = 'recharge-cell-dialog';
        dialog.setAttribute('aria-labelledby', 'recharge-cell-dialog-title');
        dialog.innerHTML = `
          <h2 id="recharge-cell-dialog-title">完整内容</h2>
          <div class="recharge-cell-full-text"></div>
          <form method="dialog"><button class="btn btn-secondary" autofocus>关闭</button></form>`;
        document.body.append(dialog);
      }
      dialog.querySelector('.recharge-cell-full-text').textContent = preview.textContent;
      dialog.showModal();
    });
  }

  function setupAdminDrafts() {
    if (standalone || document.body.dataset.rechargeView !== 'admin') return;
    let bridge;
    try {
      if (window.parent.location.origin === origin) bridge = window.parent.IDRechargeDrafts;
    } catch { return; }
    if (!bridge) return;
    // Only ordinary editable fields belong to a navigation draft. Authorization JSON,
    // redemption/query codes, passwords, card data and one-time confirmations never do.
    const groups = {
      orbitcard: ['orbitcard_live_management', 'orbitcard_base_url'],
      config: ['max_concurrent_activations'],
      maintenance: ['maintenance_mode'],
      telegram: ['telegram_admin_chat_id', 'telegram_group_chat_id', 'telegram_notify_admin',
        'telegram_notify_group', 'telegram_on_success', 'telegram_on_failure', 'telegram_on_card_pool_empty'],
      hcaptcha: ['hcaptcha_enabled', 'hcaptcha_no_vlm', 'hcaptcha_captcha_platform_api_url',
        'hcaptcha_captcha_platform_timeout', 'hcaptcha_vlm_base_url', 'hcaptcha_vlm_model',
        'hcaptcha_vlm_timeout', 'hcaptcha_solver_timeout', 'hcaptcha_cdp_port'],
      region: ['region_selector'],
      checkout: ['checkout_plan_type', 'checkout_plan_name', 'checkout_region_selector', 'checkout_log_autoscroll'],
      usage: ['orbitcard_usage_keyword', 'orbitcard_usage_plan', 'orbitcard_usage_card_status', 'orbitcard_usage_recharge_status'],
      strategy: ['orbitcard_strategy_product_code', ...['plus', 'pro100', 'pro200', 'pro500']
        .flatMap(plan => ['orbitcard_reuse_limit_' + plan, 'orbitcard_safety_margin_' + plan])],
      cdk: ['cdk_plan_type', 'cdk_count'],
      session: ['session_search'],
      runtime: ['runtime_log_autoscroll', 'runtime_log_pause'],
      ban: ['ip_ban_cidr', 'ip_ban_reason', 'ip_ban_duration']
    };
    const addressFields = ['addr_line1', 'addr_city', 'addr_state', 'addr_postal_code', 'addr_country'];
    const ordinaryFields = new Set(Object.values(groups).flat());
    const addressKey = () => {
      const id = document.getElementById('address_edit_id')?.value || 'new';
      return /^(?:new|[1-9]\d{0,15})$/.test(id) ? id : null;
    };
    const fieldKey = element => ordinaryFields.has(element?.id) ? element.id :
      addressFields.includes(element?.id) && addressKey() ? `address/${addressKey()}/${element.id}` : null;
    const read = () => bridge.read('admin') || {};
    const write = values => bridge.write('admin', values);
    const valueOf = element => element.type === 'checkbox' ? element.checked : element.value;
    const capture = event => {
      const key = fieldKey(event.target);
      if (!key) return;
      const values = read();
      values[key] = valueOf(event.target);
      if (key === 'checkout_plan_type') delete values.checkout_plan_name;
      write(values);
    };
    document.addEventListener('input', capture, true);
    document.addEventListener('change', capture, true);
    restoreDrafts = () => {
      const values = read();
      for (const id of [...ordinaryFields, ...addressFields]) {
        if (id === 'checkout_plan_name') continue;
        const element = document.getElementById(id);
        const key = fieldKey(element);
        if (!element || !key || !Object.hasOwn(values, key)) continue;
        if (element.type === 'checkbox') element.checked = values[key] === true;
        else if (element.tagName !== 'SELECT' || [...element.options].some(option => option.value === values[key]))
          element.value = values[key];
      }
      // Update presentation without dispatching change events that could submit a setting.
      window.renderOrbitcardStrategyDetails?.();
      if (Object.hasOwn(values, 'checkout_plan_type') || Object.hasOwn(values, 'checkout_plan_name')) {
        window.syncCheckoutPlanName?.();
        if (Object.hasOwn(values, 'checkout_plan_name'))
          document.getElementById('checkout_plan_name').value = values.checkout_plan_name;
      }
      if (Object.hasOwn(values, 'checkout_region_selector')) window.onCheckoutRegionChange?.();
    };
    const wrapRestore = name => {
      const original = window[name];
      if (typeof original !== 'function') return;
      window[name] = function (...args) {
        const result = original.apply(this, args);
        if (result && typeof result.then === 'function') return result.finally(restoreDrafts);
        restoreDrafts();
        return result;
      };
    };
    for (const name of ['applySystemConfigFromData', 'loadOrbitcardConfig', 'loadRegionConfig',
      'loadCheckoutPlans', 'loadCheckoutDebugPage', 'loadOrbitcardProductStrategy', 'showAddressForm'])
      wrapRestore(name);

    const savedGroups = {
      '/api/admin/orbitcard/config': groups.orbitcard,
      '/api/admin/config': groups.config,
      '/api/admin/telegram': groups.telegram,
      '/api/admin/hcaptcha': groups.hcaptcha,
      '/api/admin/region': groups.region,
      '/api/admin/orbitcard/product-strategy': groups.strategy,
      '/api/admin/ip-bans': groups.ban
    };
    const originalFetch = window.authFetch;
    if (typeof originalFetch === 'function') window.authFetch = async function (url, options = {}) {
      const path = new URL(url, origin).pathname.replace(/^\/integrations\/codexdaichong/, '');
      let keys = ['POST', 'PUT'].includes(options.method) ? savedGroups[path] : null;
      if (keys && path === '/api/admin/config') {
        const payload = JSON.parse(options.body || '{}');
        keys = [...groups.config, ...groups.maintenance].filter(key => Object.hasOwn(payload, key));
      }
      if (['POST', 'PUT'].includes(options.method) && /^\/api\/admin\/addresses(?:\/[1-9]\d*)?$/.test(path))
        keys = addressFields.map(id => `address/${addressKey()}/${id}`);
      const current = read();
      const snapshot = Object.fromEntries((keys || []).filter(key => Object.hasOwn(current, key))
        .map(key => [key, current[key]]));
      const response = await originalFetch.call(this, url, options);
      if (keys && response.ok) {
        const result = await response.clone().json().catch(() => null);
        if (result?.success === true) {
          const latest = read();
          for (const [key, value] of Object.entries(snapshot))
            if (latest[key] === value) delete latest[key];
          write(latest);
        }
      }
      return response;
    };
    const resetUsage = window.resetOrbitcardUsageFilters;
    if (typeof resetUsage === 'function') window.resetOrbitcardUsageFilters = function (...args) {
      const values = read();
      for (const id of groups.usage) delete values[id];
      write(values);
      return resetUsage.apply(this, args);
    };
    restoreDrafts();
  }

  function setupWorkspaceClipboard() {
    for (const actions of document.querySelectorAll('[data-workspace-clipboard]')) {
      const input = document.getElementById(actions.dataset.workspaceClipboard);
      const status = document.getElementById(input.id + 'ClipboardStatus');
      const paste = actions.querySelector('[data-paste]');
      const clear = actions.querySelector('[data-clear]');
      const singleLine = input instanceof HTMLInputElement;
      let revision = 0;
      function syncButtons() {
        paste.disabled = input.readOnly;
        clear.disabled = input.readOnly || !input.value;
      }
      function editable() {
        return window.idRechargeVisible && input.getClientRects().length > 0 &&
          !input.readOnly && !input.matches(':disabled');
      }
      function apply(value) {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      input.addEventListener('input', () => {
        revision++;
        status.textContent = '';
        syncButtons();
      });
      new MutationObserver(() => {
        revision++;
        syncButtons();
      }).observe(input, { attributes: true, attributeFilter: ['readonly'] });
      syncButtons();
      clear.addEventListener('click', () => {
        if (!editable()) return;
        apply('');
        input.focus();
      });
      paste.addEventListener('click', async () => {
        if (!editable()) return;
        const started = ++revision;
        const previous = input.value;
        const current = () => started === revision && previous === input.value && editable();
        status.textContent = '';
        let text;
        try {
          text = await navigator.clipboard.readText();
        } catch {
          if (current()) {
            input.focus();
            status.textContent = '无法读取剪贴板，请在输入框内手动粘贴。';
          }
          return;
        }
        if (!current()) return;
        if (!text.trim()) {
          status.textContent = '剪贴板没有可粘贴的文本。';
          return;
        }
        if (singleLine) {
          text = text.trim();
          if (text.length > input.maxLength || /[\r\n]/.test(text)) {
            status.textContent = '请复制一条完整的兑换码后再粘贴。';
            return;
          }
        }
        apply(text);
      });
    }
  }

  function setupWorkspaceGuide() {
    for (const control of document.querySelectorAll('[data-workspace-tab]')) {
      control.addEventListener('click', (event) => {
        event.preventDefault();
        const tab = document.querySelector(`[data-tab="${control.dataset.workspaceTab}"]`);
        window.idRechargeSelect(control.dataset.workspaceTab);
        tab.focus();
      });
    }
    const url = document.getElementById('workspace-session-url');
    const copy = document.getElementById('workspace-copy-session-url');
    const result = document.getElementById('workspace-copy-result');
    url.addEventListener('focus', () => url.select());
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url.defaultValue);
        result.textContent = '已复制公开页面地址。打开后请复制自己的完整 JSON。';
      } catch {
        url.focus();
        result.textContent = '无法自动复制。请手动复制已选中的公开网址。';
      }
    });
    for (const id of ['workspace-guide-title', 'workspace-query-title']) {
      const title = document.getElementById(id);
      window.IDTitleHelp.attach(title, title.nextElementSibling);
    }
  }

  function updateTelegramStatus() {
    if (!telegramStatus) return;
    const status = root.dataset.rechargeTelegram;
    telegramStatus.hidden = status === 'ready';
    telegramStatus.textContent = {
      loading: '正在读取原代充 Telegram 设置…',
      'telegram-locked': '代充通知已进入统一接管，请在监控与通知核对。',
      'session-expired': '统一登录已失效，请重新登录。',
      unavailable: '暂时无法读取原代充 Telegram 设置，请关闭后重新打开。'
    }[status] || '';
  }

  function placeTelegramSettings() {
    const panel = document.querySelector('[data-recharge-telegram-form]');
    if (!panel) return;
    if (!telegramSettings) {
      panel.remove();
      return;
    }
    const main = panel.closest('main');
    const title = panel.querySelector('.panel-title');
    title.nextElementSibling?.remove();
    title.remove();
    panel.style.removeProperty('margin-top');
    for (const row of panel.querySelectorAll('.toggle-field')) {
      const label = row.querySelector('.toggle-label');
      const input = row.querySelector('input');
      label.id = input.id + '-label';
      input.setAttribute('aria-labelledby', label.id);
    }
    telegramStatus = document.createElement('p');
    telegramStatus.setAttribute('role', 'status');
    main.append(telegramStatus, panel);
    updateTelegramStatus();
  }

  window.addEventListener('DOMContentLoaded', () => {
    if (window.idRechargeTaskLog) {
      const dialog = document.querySelector('#task_log_modal_overlay .task-log-modal');
      dialog.removeAttribute('role');
      dialog.removeAttribute('aria-modal');
      document.getElementById('task_log_modal_body').tabIndex = 0;
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        window.parent.postMessage({ source: 'id-codexdaichong', type: 'close-task-log' }, origin);
      });
      return;
    }
    if (standalone) document.body.dataset.standalone = 'true';
    syncWorkspaceViewport = setupWorkspaceViewport();
    setupAdminDrafts();
    if (document.body.dataset.rechargeView === 'admin') {
      placeTelegramSettings();
      setupRechargeCellText();
      const subtitleSelector =
        'p:not([id]):not([role]), #orbitcard_usage_hint, .log-page-toolbar-hint';
      for (const title of document.querySelectorAll('h2.panel-title, .log-page-toolbar h2')) {
        const row = title.closest('.panel-header, .runtime-log-toolbar') || title;
        const subtitle = title.nextElementSibling?.matches(subtitleSelector)
          ? title.nextElementSibling
          : row.nextElementSibling;
        if (subtitle?.matches(subtitleSelector)) window.IDTitleHelp.attach(title, subtitle);
      }
      const runtimeHint = document.querySelector('#runtime_logs .runtime-log-hint');
      const runtimeDescription = document.querySelector('#runtime_logs .page-header > p');
      if (runtimeHint && runtimeDescription) {
        runtimeDescription.append(' ', ...runtimeHint.childNodes);
        runtimeHint.remove();
      }
      if (standalone) {
        for (const title of document.querySelectorAll('.page-header > h1'))
          window.IDTitleHelp.attach(title, title.nextElementSibling);
      } else styleAdminLayout();
      updateTableLayout = window.IDPagination?.watchTableLayout?.(
        document.querySelector('.main-content'),
        { hostFrame: window.frameElement, rows: '.table-container' }
      );
    } else {
      const tab = new URLSearchParams(location.search).get('tab');
      const workspaceTitle = document.querySelector('.workspace-recharge-standalone-title');
      if (workspaceTitle) {
        setupWorkspaceLog();
        if (standalone)
          window.IDTitleHelp.attach(
            workspaceTitle.querySelector('h1'),
            workspaceTitle.querySelector('p')
          );
        else workspaceTitle.remove();
        window.IDTitleHelp.attach(
          document.querySelector('#workspace-code-title'),
          document.querySelector('#workspace-code-title + p')
        );
        window.IDTitleHelp.attach(
          document.querySelector('#workspace-account-title'),
          document.querySelector('#workspace-account-title + p')
        );
        setupWorkspaceGuide();
        setupWorkspaceClipboard();
      } else if (!standalone && tab === 'query') {
        document.body.dataset.rechargeQuery = '';
      } else {
        window.IDTitleHelp.attach(
          document.querySelector('.card-head h2'),
          document.querySelector('.card-head p')
        );
        window.IDTitleHelp.attach(
          document.querySelector('.compact-hero h1'),
          document.querySelector('.hero-subtitle')
        );
      }
      window.idRechargeSelect(tab);
      report('ready');
    }
    const observer = new ResizeObserver((entries) => {
      for (const { target } of entries) {
        if (target === document.body) {
          if (reportType === 'ready') report('resize');
        } else if (target.parentElement?.querySelector('input[id$="_log_autoscroll"]:checked')) {
          target.scrollTop = target.scrollHeight;
        }
      }
    });
    observer.observe(document.body);
    if (root.hasAttribute('data-recharge-viewport'))
      for (const log of document.querySelectorAll('.runtime-log-pre-wrap')) observer.observe(log);
  });
})();
