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

  async function verify({ whenAvailable = false } = {}) {
    const info = await request('security');
    if (info.recentlyVerified || (whenAvailable && (!info.available || info.requiredForExistingActions === false)))
      return true;
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

  async function bindFactor(info, host) {
    const { bound, canRebind } = info;
    if (bound && !canRebind && !(await verify())) return;
    let enrollment, completed = false;
    await confirmation(bound ? '更换身份验证器' : '绑定两步验证',
      '<label for="local-security-password">当前登录密码</label><input id="local-security-password" name="password" type="password" autocomplete="current-password" required />',
      '下一步', async (fields, container, submit) => {
        if (completed) return true;
        if (!enrollment) {
          const data = await request('security/start', 'POST', { password: fields.password });
          enrollment = data.enrollment;
          container.innerHTML = `<p>在身份验证器选择手动输入，填写下列密钥，再输入当前的六位验证码。</p>
            <label for="local-security-key">绑定密钥</label><input id="local-security-key" readonly value="${E(data.setupKey)}" />
            <label for="local-security-enrollment-code">六位动态验证码</label>
            <input id="local-security-enrollment-code" name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required />`;
          $('#local-security-key').select();
          submit.textContent = '确认绑定';
          return;
        }
        const data = await request('security/confirm', 'POST', { enrollment, code: fields.code });
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
          if (action === 'verify') return A.notify('安全确认通过，5 分钟内可继续重要操作');
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
  function render() {
    return A.header('登录安全', '管理允许登录的网络、查看真人验证状态和待批准的设备。') +
      `<section class="panel" data-login-security><div class="toolbar"><div class="toolbar-right">
        ${button('data-network-action="reload"', '刷新')}</div></div><div class="panel-body" data-network-content aria-live="polite">正在读取登录安全设置…</div></section>`;
  }

  async function load() {
    if (!host?.isConnected) return;
    const id = ++loadId;
    const content = $('[data-network-content]', host);
    content.setAttribute('aria-busy', 'true');
    try {
      const [network, devices, activity] = await Promise.all([
        request('security/network'), request('security/device-requests'), request('security/activity')
      ]);
      if (id !== loadId || !content.isConnected) return;
      const { policy, address, challengeEnabled, connectable, lastRecovery } = network;
      const reasons = { limited: '尝试过于频繁', network: '网络未获准', challenge: '真人验证未通过',
        credentials: '账号或密码未通过', verification: '两步验证码未通过', device: '设备等待批准' };
      const stamp = at => E(new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
      content.innerHTML = `<div class="property-list">
        <div class="property-row"><span>登录真人验证</span><strong>${challengeEnabled ? '已启用' : '尚未启用'}</strong></div>
        <div class="property-row"><span>当前网络地址</span><strong>${address ? E(address) : '尚未取得'}</strong></div>
        <div class="property-row"><span>登录网络限制</span><strong>${policy.mode === 'enforce' ? '只允许名单内网络' : '目前允许登录'}</strong></div>
        ${lastRecovery ? `<div class="property-row"><span>上次恢复登录权限</span><strong>${stamp(lastRecovery.at)}</strong></div>` : ''}
      </div>
      <div class="section-title-row"><h2>允许登录的网络</h2>${A.titleInfo('允许登录的网络',
        '先登记当前使用的公司网络，再开启限制。员工账号仍需要密码和适用的两步验证码。', 'allowed-networks-help')}</div>
      <div class="toolbar"><div class="toolbar-left">${button('data-network-action="add"', '添加允许登录的 IP')}
      ${button('data-network-action="mode"', policy.mode === 'enforce' ? '暂停网络限制' : '启用网络限制', !connectable ? 'disabled' : '')}</div></div>
      ${policy.entries.length ? policy.entries.map(row => `<article class="local-auth-device"><div><strong>${E(row.name)}</strong><p>${E(row.network)}</p></div>
        ${button(`data-network-action="remove" data-id="${E(row.id)}"`, '移除')}</article>`).join('') : '<p>还没有登记允许登录的网络。</p>'}
      <div class="section-title-row"><h2>待批准的设备</h2>${A.titleInfo('待批准的设备', '确认申请人和设备后再批准。', 'device-requests-help')}</div>
      ${devices.items.length ? devices.items.map(row => `<article class="local-auth-device"><div><strong>${E(row.employeeName)}</strong><p>${E(row.name)} · ${E(new Date(row.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</p></div><div class="action-links">
        ${button(`data-network-action="approve" data-id="${E(row.id)}" data-employee="${E(row.employeeId)}"`, '批准')}
        ${button(`data-network-action="reject" data-id="${E(row.id)}" data-employee="${E(row.employeeId)}"`, '拒绝')}</div></article>`).join('') : '<p>暂无设备申请。</p>'}
      <div class="section-title-row"><h2>近期登录拦截</h2>${A.titleInfo('近期登录拦截',
        '显示网站本次运行期间最近一天的拦截，最多保留十条可查看记录。', 'login-blocks-help')}</div>
      ${activity.items.length ? `<ul class="security-blocks">${activity.items.map(row =>
        `<li><strong>${E(reasons[row.kind] || '登录未通过')}</strong> <span>${stamp(row.at)}</span></li>`).join('')}</ul>` : '<p>暂无近期拦截记录。</p>'}
      <div class="toolbar"><a class="button" href="#/settings/audit">查看操作记录</a></div>`;
      host.dataset.version = policy.version;
      host.dataset.mode = policy.mode;
    } catch (error) { if (id === loadId && content.isConnected) content.textContent = error.message; }
    finally { if (id === loadId) content.removeAttribute('aria-busy'); }
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
