(function () {
  const origin = window.location.origin;
  const standalone = window.parent === window;
  const root = document.documentElement;
  const taskLog = new URLSearchParams(window.location.search).get('taskLog');
  if (!standalone && window.location.pathname.endsWith('/admin') && /^[\w-]{1,128}$/.test(taskLog ?? '')) {
    root.dataset.rechargeTaskLog = '';
    window.idRechargeTaskLog = taskLog;
  }
  root.dataset.rechargeNavigationLocked = 'false';
  let reportType = '';
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
    if (type !== 'resize' && type !== 'view-context') reportType = type;
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
    } else if (!standalone && message.type === 'data-change' &&
        Array.isArray(message.scopes) && message.scopes.includes('card-types')) {
      window.idRechargeCardTypesChanged?.();
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
      gpt: ['gpt_api_enabled', 'gpt_api_base_url', 'gpt_api_plan_key',
        'gpt_api_plan_key_pro100', 'gpt_api_plan_key_pro200', 'gpt_api_plan_key_pro500',
        'gpt_api_payment_region', 'gpt_api_card_source', 'orbitcard_base_url'],
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
      window.updateOrbitcardConfigVisibility?.();
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
    for (const name of ['applySystemConfigFromData', 'loadGptApiConfig', 'loadRegionConfig',
      'loadCheckoutPlans', 'loadCheckoutDebugPage', 'loadOrbitcardProductStrategy', 'showAddressForm'])
      wrapRestore(name);

    const savedGroups = {
      '/api/admin/gpt-api': groups.gpt,
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
    setupAdminDrafts();
    if (document.body.dataset.rechargeView === 'admin') {
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
    } else {
      const tab = new URLSearchParams(location.search).get('tab');
      const workspaceTitle = document.querySelector('.workspace-recharge-standalone-title');
      if (workspaceTitle) {
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
    const observer = new ResizeObserver(() => {
      if (reportType === 'ready') report('resize');
    });
    observer.observe(document.body);
  });
})();
