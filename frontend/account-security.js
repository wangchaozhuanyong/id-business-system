(() => {
  'use strict';
  const A = window.IDDesignAPI, Auth = window.IDLocalAuth;
  if (!A || !Auth) return;
  const request = Auth.accountRequest;
  const E = A.esc;
  const $ = (selector, root = document) => root.querySelector(selector);
  const button = (attr, label, extra = '') => `<button type="button" class="button" ${attr} ${extra}>${label}</button>`;

  function confirmation(title, fields, confirmLabel, work) {
    if ($('.local-auth-confirmation')) return Promise.resolve(false);
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'local-auth-confirmation';
      dialog.setAttribute('aria-labelledby', 'local-auth-confirmation-title');
      dialog.innerHTML = `<form class="local-auth-dialog-form"><h2 id="local-auth-confirmation-title">${E(title)}</h2>
        <div class="local-auth-verification-fields" data-security-fields>${fields}</div><p class="field-error" role="alert" hidden></p>
        <div class="form-footer"><button class="button" type="button" data-security-cancel>取消</button>
        <button class="button primary" type="submit">${E(confirmLabel)}</button></div></form>`;
      document.body.append(dialog);
      const form = $('form', dialog);
      const error = $('[role="alert"]', dialog);
      const submit = $('[type="submit"]', dialog);
      const cancel = $('[data-security-cancel]', dialog);
      let result = false, busy = false;
      cancel.addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
      dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy) return;
        busy = true;
        error.hidden = true;
        submit.disabled = cancel.disabled = true;
        try {
          const value = await work(Object.fromEntries(new FormData(form)), $('[data-security-fields]', dialog), submit);
          if (value !== undefined) { result = value; dialog.close(); }
        } catch (failure) {
          error.textContent = failure.message || '操作未完成，请重试。';
          error.hidden = false;
        } finally {
          busy = false;
          submit.disabled = cancel.disabled = false;
        }
      });
      dialog.showModal();
    });
  }

  async function verifyAuthenticator(info) {
    if (info.recentlyVerified) return true;
    if (!info.available) throw new Error('两步验证尚未启用，请联系超级管理员。');
    if (!info.bound) {
      A.notify('请先在「我的账号」绑定两步验证');
      return false;
    }
    return confirmation('确认是你本人', `<label for="local-security-code">身份验证器的六位验证码</label>
      <input id="local-security-code" name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" required maxlength="6" />`,
    '验证', async fields => {
      await request('security/verify', 'POST', fields);
      return true;
    });
  }

  let passwordPrompt;
  async function verify({ whenAvailable = false } = {}) {
    const info = await request('security');
    if (info.passwordConfirmed || (whenAvailable && info.requiredForExistingActions === false)) return true;
    if (info.requiredForExistingActions && info.bound === false) {
      A.notify('请先在「我的账号」绑定两步验证，再确认重要操作');
      return false;
    }
    passwordPrompt ??= confirmation('确认重要操作',
      '<label for="local-action-password">当前登录密码</label><input id="local-action-password" name="password" type="password" autocomplete="current-password" maxlength="256" required />',
      '确认', async fields => {
        await request('security/confirm-password', 'POST', fields);
        return true;
      }).finally(() => { passwordPrompt = undefined; });
    return passwordPrompt;
  }

  async function bindFactor(info, host) {
    const { bound, canRebind } = info;
    if (bound && !canRebind && !(await verifyAuthenticator(info))) return;
    const enrollmentFields = data => `<p>在身份验证器选择手动输入，填写下列密钥，再输入当前的六位验证码。</p>
      <label for="local-security-key">绑定密钥</label><input id="local-security-key" readonly value="${E(data.setupKey)}" />
      <label for="local-security-enrollment-code">六位动态验证码</label>
      <input id="local-security-enrollment-code" name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required />`;
    if (bound && !await verify()) return;
    let enrollment = bound ? await request('security/start', 'POST', {}) : null;
    let completed = false;
    await confirmation(bound ? '更换身份验证器' : '绑定两步验证',
      enrollment ? enrollmentFields(enrollment)
        : '<label for="local-security-password">当前登录密码</label><input id="local-security-password" name="password" type="password" autocomplete="current-password" required />',
      enrollment ? '确认绑定' : '下一步', async (fields, container, submit) => {
        if (completed) return true;
        if (!enrollment) {
          enrollment = await request('security/start', 'POST', { password: fields.password });
          container.innerHTML = enrollmentFields(enrollment);
          $('#local-security-key').select();
          submit.textContent = '确认绑定';
          return;
        }
        const data = await request('security/confirm', 'POST', { enrollment: enrollment.enrollment, code: fields.code });
        completed = true;
        container.innerHTML = `<p>请把恢复码保存到安全地点。每个恢复码只能使用一次，关闭后无法再次查看。</p>
          <label for="local-security-recovery-codes">恢复码</label>
          <textarea id="local-security-recovery-codes" readonly rows="8">${E(data.recoveryCodes.join('\n'))}</textarea>`;
        submit.textContent = '已保存恢复码';
        $('[data-security-cancel]', container.closest('dialog')).textContent = '关闭';
        $('#local-security-recovery-codes').select();
      });
    if (host.isConnected) await personal(host);
    if (completed) A.notify('两步验证已绑定');
  }

  async function personal(host) {
    if (!host?.isConnected) return;
    host.textContent = '正在读取账号安全设置…';
    try {
      const info = await request('security');
      if (!host.isConnected) return;
      if (!info.available) { host.textContent = '两步验证尚未启用，请联系管理员。'; return; }
      const currentApproved = info.devices.some(row => row.current && row.state === 'approved');
      host.innerHTML = `<div class="property-list">
        <div class="property-row"><span>两步验证</span><strong>${info.bound ? '已绑定' : '未绑定'}</strong></div>
        ${info.bound ? `<div class="property-row"><span>剩余恢复码</span><strong>${info.recoveryRemaining} 个</strong></div>
          <div class="property-row"><span>限制登录设备</span><strong>${info.deviceLock ? '已启用' : '未启用'}</strong></div>` : ''}
        </div><div class="toolbar"><div class="toolbar-left">
        ${button('data-my-security="bind"', info.bound ? '更换验证器' : '绑定两步验证')}
        ${info.bound ? button('data-my-security="verify"', '安全确认') +
          (!currentApproved ? button('data-my-security="add-current"', '信任当前设备') : '') +
          button('data-my-security="set-lock"', info.deviceLock ? '取消设备限制' : '只允许已批准设备',
            !info.deviceLock && !currentApproved ? 'disabled' : '') : ''}
        </div></div>${info.devices.map(row => `<article class="local-auth-device"><div><strong>${E(row.name)}${row.current ? '（当前）' : ''}</strong><p>${row.state === 'approved' ? '已批准' : '等待批准'}</p></div><div class="action-links">
          ${row.state === 'pending' ? button(`data-my-security="approve" data-id="${E(row.id)}"`, '批准') : ''}
          ${button(`data-my-security="remove" data-id="${E(row.id)}"`, '移除', row.current && info.deviceLock ? 'disabled' : '')}</div></article>`).join('')}`;
      for (const control of host.querySelectorAll('[data-my-security]')) control.addEventListener('click', async () => {
        const action = control.dataset.mySecurity;
        control.disabled = true;
        try {
          if (action === 'bind') return await bindFactor(info, host);
          if (!(await verify())) return;
          if (action === 'verify') return A.notify('安全确认通过，当前登录会话可在确认后 1 小时内继续重要操作');
          await request('security/device', 'POST', { action, id: control.dataset.id, enabled: !info.deviceLock });
          await personal(host);
          A.notify('设置已保存');
        } catch (error) { A.notify(error.message); }
        finally { control.disabled = false; }
      });
    } catch (error) { if (host.isConnected) host.textContent = error.message; }
  }

  const route = 'settings/security';
  let host, loadId = 0;
  const reasons = { limited: '尝试过于频繁', network: '网络未获准', challenge: '真人验证未通过',
    credentials: '账号或密码未通过', verification: '两步验证码未通过', device: '设备等待批准' };
  function beijingTime(at) {
    const date = new Date(at);
    if (!Number.isFinite(date.getTime())) return '时间待核对';
    return `<time datetime="${date.toISOString()}">${E(date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</time>`;
  }

  function securityPanel(id, title, help, actions, body) {
    return `<section class="panel security-panel" aria-labelledby="security-${id}">
      <div class="panel-heading"><div class="section-title-row"><h2 id="security-${id}">${title}</h2>
      ${A.titleInfo(title, help, id + '-help')}</div>${actions}</div>${body}</section>`;
  }

  function summary(data) {
    const facts = [
      ['登录真人验证', data && A.tag(data.challengeEnabled ? '已启用' : '未启用', data.challengeEnabled ? 'success' : '')],
      ['登录网络限制', data && A.tag(data.policy.mode === 'enforce' ? '仅允许名单内网络' : '未启用', data.policy.mode === 'enforce' ? 'blue' : '')],
      ['当前网络地址', data && E(data.address || '尚未取得')]
    ];
    if (data?.lastRecovery) facts.push(['上次恢复登录权限', beijingTime(data.lastRecovery.at)]);
    return facts.map(([label, value]) => `<div class="summary-item"><dt class="summary-label">${label}</dt>
      <dd>${value || '—'}</dd></div>`).join('');
  }

  function networkControls(network) {
    const modeLabel = network ? (network.policy.mode === 'enforce' ? '暂停网络限制' : '启用网络限制') : '网络限制';
    return `<button type="button" class="button primary" data-network-action="add" ${network ? '' : 'disabled'}>${A.icon('plus')}添加 IP</button>
      ${button('data-network-action="mode"', modeLabel, network?.connectable ? '' : 'disabled')}`;
  }

  const emptyMessage = text => `<p class="security-empty">${text}</p>`;
  function render() {
    const waiting = emptyMessage('正在读取…');
    return A.header('登录安全', '查看登录状态，管理允许登录的网络并处理设备申请。') +
      `<div class="security-workspace" data-login-security>
      ${securityPanel('overview', '当前状态', '当前网络地址来自本次访问，所有时间均为北京时间。',
        button('data-network-action="reload"', '刷新'),
        `<p class="inline-notice warning" data-security-error role="alert" hidden></p>
         <dl class="summary-strip security-summary" data-security-summary aria-live="polite">${summary()}</dl>`)}
      <div class="security-columns">
      ${securityPanel('allowed-networks', '允许登录的网络', '先登记当前使用的公司网络，再开启限制。员工账号仍需要密码和适用的两步验证码。',
        `<div class="security-actions" data-network-controls>${networkControls()}</div>`,
        `<div data-security-networks>${waiting}</div>`)}
      ${securityPanel('device-requests', '待批准的设备', '核对申请人、设备和申请时间，再选择批准或拒绝。', '',
        `<div data-security-devices>${waiting}</div>`)}
      </div>
      ${securityPanel('login-blocks', '近期登录拦截', '显示网站本次运行期间最近一天的拦截，最多十条，按北京时间从新到旧排列。',
        '<a class="button" href="#/settings/audit">查看操作记录</a>', `<div data-security-blocks>${waiting}</div>`)}
      <span data-security-progress role="status" hidden></span></div>`;
  }

  function securityList(rows, item, empty) {
    return rows.length ? `<ul class="security-records">${rows.map(row => `<li>${item(row)}</li>`).join('')}</ul>` : emptyMessage(empty);
  }

  async function load() {
    if (!host?.isConnected) return;
    const view = host, id = ++loadId;
    const errorBox = $('[data-security-error]', view);
    const feedback = A.beginRegionRead(view, $('[data-security-progress]', view), {
      refreshButton: $('[data-network-action="reload"]', view)
    });
    errorBox.hidden = true;
    try {
      const [network, devices, activity] = await Promise.all([
        request('security/network'), request('security/device-requests'), request('security/activity')
      ]);
      if (id !== loadId || !view.isConnected) return;
      const { policy } = network;
      $('[data-security-summary]', view).innerHTML = summary(network);
      $('[data-network-controls]', view).innerHTML = networkControls(network);
      $('[data-security-networks]', view).innerHTML = securityList(policy.entries, row =>
        `<div class="security-record-text"><strong>${E(row.name)}</strong><span>${E(row.network)}</span></div>
         ${button(`data-network-action="remove" data-id="${E(row.id)}"`, '移除')}`, '还没有登记允许登录的网络。');
      $('[data-security-devices]', view).innerHTML = securityList(devices.items, row =>
        `<div class="security-record-text"><strong>${E(row.employeeName)}</strong><span>${E(row.name)}</span>${beijingTime(row.at)}</div>
         <div class="security-actions">${button(`data-network-action="approve" data-id="${E(row.id)}" data-employee="${E(row.employeeId)}"`, '批准')}
         ${button(`data-network-action="reject" data-id="${E(row.id)}" data-employee="${E(row.employeeId)}"`, '拒绝')}</div>`, '暂无设备申请。');
      $('[data-security-blocks]', view).innerHTML = securityList(activity.items, row =>
        `${beijingTime(row.at)}<strong>${E(reasons[row.kind] || '登录未通过')}</strong>`, '暂无近期拦截记录。');
      view.dataset.version = policy.version;
      view.dataset.mode = policy.mode;
    } catch (error) {
      if (id !== loadId || !view.isConnected) return;
      const retain = view.dataset.version !== undefined && error.status !== 401 && error.status !== 403;
      if (!retain) {
        delete view.dataset.version;
        delete view.dataset.mode;
        $('[data-security-summary]', view).innerHTML = summary();
        $('[data-network-controls]', view).innerHTML = networkControls();
        for (const content of view.querySelectorAll('[data-security-networks], [data-security-devices], [data-security-blocks]'))
          content.innerHTML = emptyMessage('暂未取得数据');
      }
      const message = (error.message || '读取失败').replace(/[。.!！]+$/, '');
      errorBox.textContent = message + (retain ? '。当前显示上次读取的内容，可点击刷新重试。' : '。请点击刷新重试。');
      errorBox.hidden = false;
    } finally { feedback.finish(); }
  }

  function confirmChange(title, note) {
    return confirmation(title, `<p>${E(note)}</p>`, '确认', async () => true);
  }

  function activate() {
    const region = A.activePageRegion();
    host = $('[data-login-security]', region);
    if (!host) return;
    host.addEventListener('click', async event => {
      const control = event.target.closest('[data-network-action]');
      if (!control || control.disabled) return;
      const action = control.dataset.networkAction;
      control.disabled = true;
      try {
        if (action === 'reload') return await load();
        if (!await verify()) return;
        const version = Number(host.dataset.version);
        if (action === 'add') {
          const saved = await confirmation('登记允许登录的网络',
            '<label for="network-name">名称</label><input id="network-name" name="name" required maxlength="80" placeholder="如 公司办公室" />' +
            '<label for="network-address">IP 地址或网段</label><input id="network-address" name="network" required maxlength="80" />',
          '保存', async fields => { await request('security/network', 'POST', { ...fields, action, version }); return true; });
          if (!saved) return;
        } else if (action === 'approve' || action === 'reject') {
          if (!await confirmChange(action === 'approve' ? '批准登录设备' : '拒绝设备申请', '请核对申请人与设备。')) return;
          await request('security/device', 'POST', { action: action === 'approve' ? 'approve' : 'remove',
            id: control.dataset.id, employeeId: control.dataset.employee });
        } else {
          const mode = host.dataset.mode === 'enforce' ? 'observe' : 'enforce';
          if (!await confirmChange(action === 'remove' ? '移除网络' : '更新登录限制',
            '网络限制生效后，名单外的会话将暂停访问。')) return;
          await request('security/network', 'POST', { action, version, id: control.dataset.id, mode });
        }
        await load();
        A.notify('设置已保存');
      } catch (error) { A.notify(error.message); }
      finally { control.disabled = false; }
    });
    void load();
  }

  window.IDAccountSecurity = Object.freeze({ verify, personal, confirmChange });
  window.IDDesignModules.push({ matches: value => value === route, sharedBusinessData: false, render, afterRender: activate,
    deactivate() { loadId++; host = null; } });
})();
