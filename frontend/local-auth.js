(() => {
  'use strict';

  const prefix = '/api/local/auth/';
  const required = document.querySelector('meta[name="id-local-auth"]')?.content === 'required';
  const setupEmail = document.querySelector('meta[name="id-local-admin-setup"]')?.content;
  const actorMeta = document.querySelector('meta[name="id-local-actor"]')?.content;
  const roles = { super: '超级管理员', admin: '普通管理员', employee: '普通员工' };
  let actor = null;
  if (required && actorMeta) {
    try {
      const candidate = JSON.parse(decodeURIComponent(actorMeta));
      if (candidate?.id && Object.hasOwn(roles, candidate.role)) actor = candidate;
    } catch {
      // An invalid identity must open the login screen.
    }
  }

  const state = Object.freeze({
    status: setupEmail ? 'setup' : !required ? 'unconfigured' : actor ? 'signed-in' : 'signed-out',
    actor
  });
  let reloading = false;
  const $ = (selector, root = document) => root.querySelector(selector);

  function concealBusiness() {
    window.IDDesignAPI?.clearPageRegions?.();
    window.IDLocalData?.queries?.clear();
    const shell = $('.app-shell');
    if (shell) shell.hidden = true;
    const skipLink = $('.skip-link');
    if (skipLink) skipLink.hidden = true;
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  }

  function reload() {
    if (reloading) return;
    reloading = true;
    concealBusiness();
    window.location.reload();
  }

  function lock(reason = 'invalid') {
    if (state.status !== 'signed-in' || reloading) return;
    const url = new URL(window.location.href);
    url.searchParams.set('auth_reason', ['expired', 'revoked', 'logout'].includes(reason) ? reason : 'invalid');
    window.history.replaceState(null, '', url);
    reload();
  }

  async function request(path, method = 'GET', body) {
    const response = await window.fetch(prefix + path, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result === null) {
      if (response.status === 401 && path !== 'login') lock(result?.reason);
      const error = new Error(result?.error || '本机账户服务暂不可用，请重试。');
      error.status = response.status;
      throw error;
    }
    return result;
  }

  async function refresh() {
    const result = await request('session');
    if (
      result.configured !== required ||
      result.actor?.id !== state.actor?.id ||
      result.actor?.role !== state.actor?.role
    ) {
      if (!result.actor && state.status === 'signed-in') lock(result.reason);
      else reload();
    }
    else if (result.actor && (result.actor.name !== actor.name || result.actor.nicknameSet !== actor.nicknameSet))
      acceptActorLabel(result.actor);
    return state;
  }

  function acceptActorLabel(next) {
    actor = next;
    const api = window.IDDesignAPI;
    if (api) api.state.actor = next;
    const profile = $('#profile-button');
    if (profile) {
      $('.avatar', profile).textContent = Array.from(next.name)[0] || '本';
      $('.profile-name', profile).textContent = next.name;
    }
    void window.IDLocalData?.refreshOperatorLabels();
  }

  async function logout() {
    await request('logout', 'POST', {});
    lock('logout');
  }

  function showLogin() {
    concealBusiness();
    const setup = Boolean(setupEmail);
    const submitLabel = setup ? '设置密码并登录' : '登录';
    const gate = document.createElement('main');
    gate.id = 'local-auth-gate';
    gate.setAttribute('aria-labelledby', 'local-auth-title');
    gate.innerHTML = `
      <header class="local-auth-header">
        <div class="local-auth-brand">
          <img class="local-auth-mark" src="/brand/ai-subscription-mark.png" width="36" height="36" alt="" />
          <span class="local-auth-brand-name">AI订阅管理系统</span>
        </div>
        <span class="local-auth-badge"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4.5 6v6c0 4.5 7.5 9 7.5 9s7.5-4.5 7.5-9V6z"/><path d="m8.5 12 2.3 2.3 4.7-4.7"/></svg>内部专网</span>
      </header>
      <aside class="local-auth-story" aria-label="品牌视觉">
        <p class="local-auth-story-copy"><span>让工作，</span><span>回到从容。</span></p>
        <p class="local-auth-story-caption">账号 / 订阅 / 订单</p>
      </aside>
      <div class="local-auth-panel"><section class="local-auth-card">
        <p class="local-auth-kicker">${setup ? 'WELCOME' : 'WELCOME BACK'}</p>
        <h1 id="local-auth-title">${setup ? '设置本机管理员密码' : '登录工作台'}</h1>
        <p class="local-auth-intro">${setup ? '首次设置只在本机进行。完成后可在系统设置中管理员工。' : '受控内部业务中枢 · 仅限授权人员登录访问。'}</p>
        <form class="local-auth-form">
          <div class="local-auth-field">
          <label for="local-auth-email">登录邮箱</label>
          <input id="local-auth-email" name="email" type="email" autocomplete="username" placeholder="请输入登录邮箱" required maxlength="254" ${setup ? 'readonly' : ''} />
          </div>
          <div class="local-auth-field">
          <label for="local-auth-password">${setup ? '新密码' : '密码'}</label>
          <div class="local-auth-password-wrapper">
            <input id="local-auth-password" name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" placeholder="${setup ? '请设置密码' : '请输入密码'}" required ${setup ? 'aria-describedby="local-auth-password-hint" maxlength="256"' : ''} />
            <button type="button" class="local-auth-password-toggle" aria-label="显示密码">
              <svg class="icon icon-eye" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
            </button>
          </div>
          ${setup ? '<p id="local-auth-password-hint">请输入至少 12 个字符。</p>' : ''}
          </div>
          ${setup ? `<div class="local-auth-field">
          <label for="local-auth-confirmation">确认密码</label>
          <div class="local-auth-password-wrapper">
            <input id="local-auth-confirmation" name="confirmation" type="password" autocomplete="new-password" placeholder="请再次输入密码" required maxlength="256" />
            <button type="button" class="local-auth-password-toggle" aria-label="显示密码">
              <svg class="icon icon-eye" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
            </button>
          </div></div>` : ''}
          <div class="local-auth-remember-row"><label class="local-auth-remember" for="local-auth-remember"><input id="local-auth-remember" name="remember" type="checkbox" />在此设备保持登录</label></div>
          <p class="local-auth-reason" role="status" hidden></p>
          <p class="local-auth-error" role="alert" hidden></p>
          <button type="submit" class="button primary">${submitLabel}</button>
        </form>
        <p class="local-auth-footnote"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="10" width="12" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>仅限授权人员访问</p>
      </section></div>
      <footer class="local-auth-footer"><span>账号 · 订阅 · 订单</span><span>内部工作台</span></footer>`;
    document.body.append(gate);
    window.IDTitleHelp.attach($('#local-auth-title', gate), $('.local-auth-intro', gate));
    const help = document.createElement('span');
    help.textContent = '保持登录后，实际操作时自动续期；闲置30天或首次登录满90天需重新登录。未勾选时登录有效期为8小时。更新网站不会主动退出。';
    window.IDTitleHelp.attach($('.local-auth-remember', gate), help, 'field-help');
    const reasons = { expired: '登录已到期，请重新登录。', revoked: '账号密码、权限或启用状态已变化，请重新登录。',
      invalid: '登录已失效或已在其他设备退出，请重新登录。', logout: '已安全退出登录。' };
    const reason = reasons[new URL(window.location.href).searchParams.get('auth_reason')];
    if (reason) { $('.local-auth-reason', gate).textContent = reason; $('.local-auth-reason', gate).hidden = false; }

    const form = $('form', gate);
    gate.querySelectorAll('.local-auth-password-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = btn.closest('.local-auth-password-wrapper')?.querySelector('input');
        if (!input) return;
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        btn.setAttribute('aria-label', isPassword ? '隐藏密码' : '显示密码');
        btn.classList.toggle('active', isPassword);
      });
    });
    const submit = $('button[type="submit"]', form);
    const email = $('#local-auth-email', form);
    const password = $('#local-auth-password', form);
    const confirmation = $('#local-auth-confirmation', form);
    if (setup) email.value = setupEmail;
    const notice = $('.local-auth-error', form);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      notice.hidden = true;
      form.setAttribute('aria-busy', 'true');
      submit.disabled = true;
      submit.textContent = setup ? '正在设置密码…' : '正在登录…';
      let configured = false;
      try {
        if (setup) {
          await request('setup', 'POST', { password: password.value, confirmation: confirmation.value });
          configured = true;
        }
        const result = await request('login', 'POST', {
          email: email.value.trim(),
          password: password.value,
          remember: $('#local-auth-remember', form).checked
        });
        if (!result.actor?.id) throw new Error('登录未完成，请重试。');
        const url = new URL(window.location.href);
        url.searchParams.delete('auth_reason');
        window.history.replaceState(null, '', url);
        reload();
      } catch (error) {
        if (configured || (setup && error.status === 409 && error.message.includes('请直接登录'))) reload();
        else {
          notice.textContent = error.message || '登录未完成，请重试。';
          notice.hidden = false;
        }
      } finally {
        password.value = '';
        if (confirmation) confirmation.value = '';
        if (!reloading) {
          submit.disabled = false;
          submit.textContent = submitLabel;
          form.removeAttribute('aria-busy');
          password.focus();
        }
      }
    });
    (setup ? password : email).focus();
  }

  function openProfile() {
    const api = window.IDDesignAPI;
    if (!actor || !api) return;
    const nickname = actor.nicknameSet ? '' : `<form id="local-auth-nickname" class="form-section">${api.field('设置昵称', 'self-nickname', api.input('self-nickname', '', 'required maxlength="80" autocomplete="off"'), true, '首次保存后由管理员修改。')}<div class="form-footer"><button type="submit" class="button primary">保存昵称</button></div></form>`;
    api.openDrawer(
      '当前登录账户',
      '登录设备只显示本账号的会话。保持登录会在实际操作时续期，闲置30天或登录满90天需重新登录；退出某个设备会立即撤销该设备的访问权限。',
      `<div class="property-list"><div class="property-row"><span>昵称</span><strong>${api.esc(actor.name)}</strong></div><div class="property-row"><span>登录邮箱</span><strong>${api.esc(actor.email)}</strong></div><div class="property-row"><span>角色</span><strong>${roles[actor.role]}</strong></div></div>${nickname}<section class="local-auth-devices" aria-labelledby="local-auth-devices-title"><div class="section-heading"><h3 id="local-auth-devices-title">登录设备</h3><button type="button" class="button" id="local-auth-devices-refresh">刷新</button></div><div id="local-auth-device-list" aria-live="polite"></div></section>`,
      `${api.button('关闭', 'drawer-close')}<button type="button" id="local-auth-sign-out" class="button danger">退出登录</button>`
    );
    const deviceList = $('#local-auth-device-list');
    const deviceRefresh = $('#local-auth-devices-refresh');
    async function loadDevices() {
      if (deviceRefresh.disabled) return;
      deviceRefresh.disabled = true;
      deviceList.setAttribute('aria-busy', 'true');
      if (!deviceList.children.length) deviceList.textContent = '正在读取登录设备…';
      try {
        const { items } = await request('devices');
        if (!deviceList.isConnected) return;
        const date = value => new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
        deviceList.innerHTML = items.map(row => `<article class="local-auth-device"><div><strong>${api.esc(row.device)}${row.current ? '（当前设备）' : ''}</strong><p>${row.remembered ? '保持登录' : '普通登录'} · 最近使用 ${api.esc(date(row.lastUsedAt))}</p><p>有效至 ${api.esc(date(row.expiresAt))}</p></div><button type="button" class="button danger" data-device-id="${api.esc(row.id)}">退出此设备</button></article>`).join('') || '<p>暂无其他登录设备。</p>';
        for (const button of deviceList.querySelectorAll('[data-device-id]')) button.addEventListener('click', () => {
          api.confirmAction('退出登录设备', '该设备将立即失去访问权限，需要重新登录才能继续使用。', async () => {
            await api.withActionFeedback(button, async () => {
              const result = await request('devices/' + button.dataset.deviceId, 'DELETE');
              if (result.current) lock('logout');
              else await loadDevices();
              return true;
            }, { pending: '正在退出设备…', success: '已退出该登录设备', failure: '退出未完成，请重试' });
          }, '退出此设备');
        });
      } catch (error) {
        if (deviceList.isConnected) deviceList.textContent = error.message || '登录设备读取失败，请点击刷新重试。';
      } finally {
        deviceRefresh.disabled = false;
        deviceList.removeAttribute('aria-busy');
      }
    }
    deviceRefresh.addEventListener('click', () => void loadDevices());
    void loadDevices();
    $('#local-auth-nickname')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const form = event.currentTarget;
      const submit = $('button[type=submit]', form);
      if (submit.disabled) return;
      submit.disabled = true;
      try {
        const result = await request('nickname', 'POST', { nickname: form.elements['self-nickname'].value.trim() });
        acceptActorLabel(result.actor);
        if (form.isConnected) openProfile();
        api.notify('昵称已保存');
      } catch (error) {
        api.notify(error.message || '昵称未保存，请重试');
      } finally {
        submit.disabled = false;
      }
    });
    const button = $('#local-auth-sign-out');
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        await logout();
      } catch (error) {
        api.notify(error.message || '退出未完成，请重试。');
      } finally {
        if (!reloading) button.disabled = false;
      }
    });
  }

  const staff = { rows: [], status: 'idle', error: '', saving: false, loading: false, tab: 'accounts' };
  let employeeRead;
  const employeeDraftKey = (id) => `local-staff:${id || 'new'}`;

  function bindEmployeeRead(api) {
    const region = $('#main [data-employee-region]');
    if (!region || employeeRead?.region === region) return;
    employeeRead?.finish();
    employeeRead = api.beginRegionRead(region, region.querySelector('[data-employee-progress]'), {
      refreshButton: $('[data-action="ops-local-staff-reload"]', region)
    });
  }
  async function loadEmployees(api, force = false) {
    if (actor?.role !== 'super') return;
    if (staff.loading) {
      bindEmployeeRead(api);
      return;
    }
    if (!force && staff.status !== 'idle') return;
    staff.loading = true;
    bindEmployeeRead(api);
    try {
      const { employees } = await request('employees');
      if (!Array.isArray(employees)) throw new Error('未收到员工账户资料。');
      staff.rows = employees;
      staff.status = 'ready';
      staff.error = '';
      return true;
    } catch (error) {
      if (staff.status !== 'ready') staff.status = 'error';
      staff.error = error.message || '无法载入员工账户。';
      return false;
    } finally {
      employeeRead?.finish();
      employeeRead = undefined;
      staff.loading = false;
      if (!reloading && api.state.route === 'settings/accounts') {
        if (staff.status === 'ready' && staff.error) {
          const notice = $('#main [data-employee-error]');
          if (notice) {
            notice.textContent = staff.error + ' 已保留上次员工列表。';
            notice.hidden = false;
          }
        } else api.render();
      }
    }
  }

  function renderEmployees(api) {
    const {
      header,
      empty,
      button,
      esc,
      textAction,
      tag,
      pageRows,
      table,
      pagination,
      state: view
    } = api;
    const title = header('员工与权限', '由超级管理员管理本机员工账户和角色。');
    if (state.status === 'unconfigured')
      return (
        title +
        `<section class="panel">${empty('尚未启用员工登录', '请先在本机初始化超级管理员。')}${button('查看操作记录', 'ops-go', '', 'orders', 'data-route="settings/audit"')}</section>`
      );
    if (actor?.role !== 'super')
      return (
        title +
        `<section class="panel">${empty('无权管理员工', '此功能仅向超级管理员开放。')}</section>`
      );
    const region = '<section class="panel design-async-region" data-employee-region><div data-employee-progress role="status" hidden></div>';
    if (staff.status === 'idle')
      return (
        title +
        `${region}<div class="design-loading-rows" aria-label="员工账户"><div class="design-loading-row"></div><div class="design-loading-row"></div><div class="design-loading-row"></div></div></section>`
      );
    if (staff.status === 'error')
      return (
        title +
        `${region}${empty('员工账户载入失败', staff.error)}${button('重试', 'ops-local-staff-reload')}</section>`
      );

    const tabs = `<div class="tabs" role="tablist" aria-label="员工与权限">${[
      ['accounts', '员工账户'],
      ['roles', '角色权限']
    ]
      .map(
        ([tab, label]) =>
          `<button type="button" class="tab ${staff.tab === tab ? 'active' : ''}" role="tab" aria-selected="${staff.tab === tab}" data-action="ops-local-staff-tab" data-id="${tab}">${label}</button>`
      )
      .join('')}</div>`;
    if (staff.tab === 'roles')
      return (
        title +
        `${region}${tabs}${table(
          [
            { id: 'name', label: '角色' },
            { id: 'access', label: '本机权限' }
          ],
          [
            {
              id: 'super',
              name: roles.super,
              access: '管理业务、查看操作记录、维护员工账户与角色'
            },
            { id: 'admin', name: roles.admin, access: '管理业务、查看操作记录' },
            { id: 'employee', name: roles.employee, access: '查看可用的库存及订单页面' }
          ],
          '',
          'local-employee-roles'
        )}</section>`
      );

    const query = String(view.query || '')
      .trim()
      .toLowerCase();
    const rows = staff.rows.filter(({ name, email }) =>
      `${name} ${email}`.toLowerCase().includes(query)
    );
    const list = rows.length
      ? table(
          [
            { id: 'name', label: '昵称' },
            { id: 'email', label: '登录邮箱' },
            { id: 'role', label: '角色', render: (row) => esc(roles[row.role] || '未知') },
            {
              id: 'active',
              label: '状态',
              render: (row) => tag(row.active ? '启用' : '停用', row.active ? 'success' : '')
            },
            {
              id: 'actions',
              label: '操作',
              action: true,
              render: (row) =>
                `<div class="action-links">${textAction('编辑', 'ops-local-staff-edit', `data-id="${esc(row.id)}"`)}${row.role === 'super' ? '' : textAction(row.active ? '停用' : '启用', 'ops-local-staff-toggle', `data-id="${esc(row.id)}"`)}</div>`
            }
          ],
          pageRows(rows, row => row.createdAt),
          '',
          'local-employee-accounts'
        ) + pagination(rows.length)
      : empty('未找到员工', '可调整关键词或新增员工。');
    return (
      title +
      `${region}${tabs}<div class="toolbar"><div class="toolbar-left"><div class="search-field">${api.icon('search')}<input id="ops-list-search" type="search" aria-label="搜索员工" value="${esc(view.query || '')}" placeholder="搜索姓名或邮箱" /></div></div><div class="toolbar-right">${button('刷新', 'ops-local-staff-reload')}${button('新增员工', 'ops-local-staff-add', 'primary', 'plus')}</div></div><div class="inline-notice warning" data-employee-error role="status" ${staff.error ? '' : 'hidden'}>${staff.error ? `${esc(staff.error)} 已保留上次员工列表。` : ''}</div>${list}</section>`
    );
  }

  function editEmployee(api, id = '') {
    if (actor?.role !== 'super' || staff.saving) return;
    const original = staff.rows.find((row) => row.id === id);
    if (id && !original) return;
    const context = employeeDraftKey(id);
    const cached = api.state.drafts.get(context);
    const stale = original && cached && Number(cached['staff-version']) !== original.version;
    const draft = cached;
    const superAccount = original?.role === 'super';
    const { field, input, select, openDrawer, button, esc } = api;
    const fields =
      field(
        '员工昵称',
        'local-staff-name',
        input(
          'local-staff-name',
          draft?.['local-staff-name'] ?? original?.name ?? '',
          'maxlength="80"'
        ),
        true
      ) +
      field(
        '登录邮箱',
        'local-staff-email',
        input(
          'local-staff-email',
          draft?.['local-staff-email'] ?? original?.email ?? '',
          `type="email" autocomplete="off" maxlength="254" ${original ? 'readonly' : ''}`
        ),
        true
      ) +
      field(
        '角色',
        'local-staff-role',
        superAccount
          ? input('local-staff-role', roles.super, 'readonly')
          : select(
              'local-staff-role',
              [
                ['employee', roles.employee],
                ['admin', roles.admin]
              ],
              draft?.['local-staff-role'] ?? original?.role ?? 'employee'
            ),
        true
      ) +
      field(
        original ? '新密码' : '登录密码',
        'local-staff-password',
        input(
          'local-staff-password',
          '',
          'type="password" autocomplete="new-password" data-no-draft'
        ),
        !original,
        original ? '留空保留原密码。新密码需为 12–128 个字符。' : '请使用 12–128 个字符。'
      );
    openDrawer(
      original ? '编辑员工' : '新增员工',
      original ? '保存后会更新该账户的本机登录资料。' : '账户启用后即可在本机登录。',
      `<form id="ops-local-staff-form" novalidate><input type="hidden" name="staff-id" value="${esc(id)}" /><input type="hidden" name="staff-version" value="${esc(draft?.['staff-version'] ?? original?.version ?? '')}" /><div class="form-grid">${fields}</div><p class="local-auth-error" role="alert" hidden></p></form>`,
      `${button('取消', 'drawer-close')}<button type="submit" class="button primary" form="ops-local-staff-form">核对并保存</button>`,
      context
    );
    if (stale) api.notify('账户资料已变化，未提交的输入已保留；保存时将再次核对版本。');
  }

  function readEmployeeDetails(form) {
    const value = (name) => form.elements.namedItem(name)?.value || '';
    return {
      id: value('staff-id'),
      version: Number(value('staff-version')),
      name: value('local-staff-name').trim(),
      email: value('local-staff-email').trim(),
      role: value('local-staff-role')
    };
  }

  function reportSaveError(api, form, error) {
    const message = error.message || '未能保存员工账户，请重试。';
    const notice = form && $('.local-auth-error', form);
    if (notice?.isConnected) {
      notice.textContent = message;
      notice.hidden = false;
    } else {
      api.notify(message);
    }
    if (error.status === 409) void loadEmployees(api, true);
  }

  async function persistEmployee(api, payload, original, form) {
    if (staff.saving || staff.loading) return;
    const context = employeeDraftKey(original?.id);
    const submittedDraft = form ? JSON.stringify(api.readDraft(form)) : null;
    staff.saving = true;
    const submit = $('button[form="ops-local-staff-form"]');
    if (submit) submit.disabled = true;
    try {
      const path = original ? 'employees/' + encodeURIComponent(original.id) : 'employees';
      const { employee } = await request(path, original ? 'PATCH' : 'POST', payload);
      if (!employee?.id) throw new Error('未收到已保存的员工账户。');
      if (original?.id === actor.id) {
        reload();
        return;
      }
      const currentForm = api.state.drawerContext === context
        ? document.querySelector('#drawer[open] #ops-local-staff-form') : null;
      if (currentForm) api.state.drafts.set(context, api.readDraft(currentForm));
      const draft = api.state.drafts.get(context);
      if (form?.isConnected && currentForm === form &&
          JSON.stringify(api.readDraft(form)) === submittedDraft) api.closeDrawer();
      if (submittedDraft && JSON.stringify(draft) === submittedDraft)
        api.state.drafts.delete(context);
      else if (submittedDraft && draft && original) {
        // This save advanced our own version; retain edits made while it was pending.
        draft['staff-version'] = String(employee.version);
        if (currentForm) currentForm.elements.namedItem('staff-version').value = String(employee.version);
      }
      api.notify('员工账户已保存');
      await loadEmployees(api, true);
    } catch (error) {
      reportSaveError(api, form, error);
    } finally {
      staff.saving = false;
      if (submit?.isConnected) submit.disabled = false;
    }
  }

  function submitEmployee(api, form) {
    if (actor?.role !== 'super' || staff.saving || staff.loading) return;
    const details = readEmployeeDetails(form);
    const original = staff.rows.find(({ id }) => id === details.id);
    if (details.id && !original) return;
    const passwordControl = form.elements.namedItem('local-staff-password');
    const password = passwordControl.value;
    const length = Array.from(password).length;
    const validPassword = !password
      ? Boolean(original)
      : length >= 12 && length <= 128 && !/[\0\r\n]/u.test(password);
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email);
    const role = original?.role === 'super' ? 'super' : details.role;
    const validRole = role === 'admin' || role === 'employee' || original?.role === 'super';
    api.setError('local-staff-name', details.name ? '' : '请填写员工昵称');
    api.setError('local-staff-email', validEmail ? '' : '请输入有效邮箱');
    api.setError('local-staff-password', validPassword ? '' : '密码需为 12–128 个字符');
    api.setError('local-staff-role', validRole ? '' : '请选择有效角色');
    if (!details.name || !validEmail || !validPassword || !validRole) return;
    const fields = { name: details.name, role, ...(password ? { password } : {}) };
    const payload = original
      ? { ...fields, version: details.version, active: original.active }
      : { ...fields, email: details.email };
    api.confirmAction('确认保存员工账户', `${details.name} · ${roles[role]}`, () => {
      passwordControl.value = '';
      void persistEmployee(api, payload, original, form);
    });
  }

  function employeeAction(api, action, id) {
    if (actor?.role !== 'super' || staff.saving) return;
    if (action === 'ops-local-staff-tab' && (id === 'accounts' || id === 'roles')) {
      staff.tab = id;
      api.render();
    } else if (action === 'ops-local-staff-add') editEmployee(api);
    else if (action === 'ops-local-staff-edit') editEmployee(api, id);
    else if (action === 'ops-local-staff-reload') void api.withActionFeedback(null,
      () => loadEmployees(api, true),
      { pending: '正在刷新员工列表…', success: '员工列表已刷新', failure: '员工列表读取失败，请重试' });
    else if (action === 'ops-local-staff-toggle') {
      const original = staff.rows.find((row) => row.id === id);
      if (!original || original.role === 'super') return;
      const active = !original.active;
      api.confirmAction(
        active ? '启用员工账户' : '停用员工账户',
        active ? `${original.name} 可以重新登录。` : `${original.name} 的当前登录会话将失效。`,
        () =>
          void persistEmployee(
            api,
            {
              name: original.name,
              role: original.role,
              active,
              version: original.version
            },
            original
          )
      );
    }
  }

  window.IDLocalAuth = Object.freeze({
    getState: () => state,
    ready: () => Promise.resolve(state),
    lock,
    refresh,
    logout,
    openProfile,
    renderEmployees,
    loadEmployees,
    submitEmployee,
    employeeAction
  });

  if (state.status === 'signed-out' || state.status === 'setup') showLogin();
  if (state.status === 'signed-in') {
    let activityPending = false, lastActivity = 0;
    let reconnectBanner;
    const watchedDocuments = new WeakSet();
    function placeConnectionStatus() {
      if (!reconnectBanner) return;
      const modals = [...document.querySelectorAll('dialog[open]')].filter(node => node.matches(':modal'));
      const focusedModal = document.activeElement?.closest('dialog');
      const host = modals.includes(focusedModal) ? focusedModal : modals.at(-1) || document.body;
      if (reconnectBanner.parentElement === host) return;
      const footer = host.querySelector(':scope > .drawer-footer, :scope > .confirm-actions');
      host.insertBefore(reconnectBanner, footer);
    }
    new MutationObserver(placeConnectionStatus).observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['open']
    });
    document.addEventListener('focusin', placeConnectionStatus);
    function connectionStatus(failed) {
      if (!failed) { reconnectBanner?.remove(); reconnectBanner = undefined; return; }
      if (reloading) return;
      if (reconnectBanner) { placeConnectionStatus(); return; }
      const banner = reconnectBanner = document.createElement('div');
      banner.id = 'local-auth-connection';
      banner.setAttribute('role', 'status');
      banner.innerHTML = '<span>连接暂时中断，已保留当前页面，请稍后重试。</span><button type="button" class="button">重新连接</button>';
      placeConnectionStatus();
      $('button', banner).addEventListener('click', async event => {
        event.currentTarget.disabled = true;
        try { await refresh(); connectionStatus(false); }
        catch { if (banner.isConnected) $('button', banner).disabled = false; }
      });
    }
    async function activity(event) {
      // Timers, SSE/polling, synthetic events and a merely open tab never renew a session.
      if (!event.isTrusted || document.hidden || activityPending || reloading || Date.now() - lastActivity < 120_000) return;
      activityPending = true;
      lastActivity = Date.now();
      try { await request('activity', 'POST', {}); connectionStatus(false); }
      catch { connectionStatus(true); lastActivity = Date.now() - 110_000; }
      finally { activityPending = false; }
    }
    function watchDocument(target) {
      if (!target || watchedDocuments.has(target)) return;
      watchedDocuments.add(target);
      target.addEventListener('pointerdown', activity, { passive: true, capture: true });
      target.addEventListener('keydown', activity, { passive: true, capture: true });
    }
    watchDocument(document);
    document.addEventListener('load', event => {
      if (event.target.tagName !== 'IFRAME') return;
      try { watchDocument(event.target.contentDocument); } catch { /* Cross-origin frames are not inspected. */ }
    }, true);
    const checkConnection = () => void refresh().then(() => connectionStatus(false), () => connectionStatus(true));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) checkConnection();
    });
    window.addEventListener('online', checkConnection);
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) checkConnection();
    });
  }
})();
