(() => {
  'use strict';
  const A = window.IDDesignAPI;
  const { esc, button, titleInfo } = A;
  const endpoint = '/api/local/manual-recharge/';
  const viewerPath = /^\/manual-workspaces\/recharge-[a-f0-9]{64}\/(?:\?run=[a-f0-9-]{36})?$/;
  const labels = { plus: 'Plus', pro100: 'Pro 100', pro200: 'Pro 200', pro500: 'Pro 500' };
  const planOptions = Object.entries(labels)
    .map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join('');
  let active;

  function render() {
    return `<div class="bit-login-layout" id="manual-workspace">
      <section class="panel bit-entry-panel" aria-label="手动充值操作">
        <header class="panel-heading mr-heading"><h2><label for="mr-json">ChatGPT 授权 JSON</label></h2>
          <button type="button" class="text-button mr-jump" id="mr-jump">跳至窗口记录</button></header>
        <div class="panel-body mr-form">
          <div class="mr-field mr-auth">
            <textarea class="input" id="mr-json" autocomplete="off" spellcheck="false" rows="3" placeholder="粘贴单个账号的授权 JSON"></textarea>
            <div class="mr-actions">
              <button class="button" type="button" id="mr-paste">粘贴</button>
              <button class="button" type="button" id="mr-clear">清空</button></div>
            <div class="mr-email"><span>账号邮箱</span><output id="mr-email">—</output>
              <button type="button" class="text-button" id="mr-copy" disabled>复制邮箱</button></div>
            <div id="mr-auth-message" role="status"></div></div>
          <div class="mr-pair"><label class="mr-field">续费套餐<select class="select" id="mr-plan"><option value="">请选择套餐</option>${planOptions}</select></label>
            <div class="mr-field"><span>目标国家</span><output id="mr-country">—</output></div></div>
          <label class="mr-field">执行 IP<select class="select" id="mr-proxy"><option value="auto">自动选择最快线路</option></select></label>
          <div id="mr-route-error" role="status"></div>
          <button type="button" class="button" id="mr-reload-routes" hidden>重新读取线路</button>
          <label class="mr-field">备注（选填）<textarea class="input" id="mr-notes" rows="2" maxlength="2000"></textarea></label>
          <div id="mr-occupancy" class="mr-occupancy" hidden><span id="mr-occupied-text" role="status"></span>
            <p id="mr-legacy-help" hidden>请粘贴旧版充值窗口的授权 JSON，或从记录选出原邮箱，再结束旧窗口。财务窗口请回到原登记结束。</p>
            <div><button type="button" class="button" id="mr-resume" hidden>继续操作</button>
              <button type="button" class="button" id="mr-release" hidden>结束并释放</button>
              <button type="button" class="button" id="mr-legacy-release" hidden>按旧账号结束</button>
              <button type="button" class="button" id="mr-reload-slot" hidden>重新核对</button></div></div>
          <div class="mr-result" id="mr-result" role="status">请选择套餐并测速。</div>
          <div class="mr-actions"><button class="button" id="mr-probe" disabled>一键测速</button>
            <button class="button primary" id="mr-launch" disabled>打开浏览器</button></div>
        </div>
      </section>
      <section class="panel mr-management" aria-labelledby="mr-window-tab">
        <header class="mr-bar"><div class="tabs mr-tabs" role="tablist" aria-label="窗口与地址">
          <button class="tab active" type="button" role="tab" id="mr-window-tab" aria-controls="mr-window-panel" aria-selected="true">浏览器窗口</button>
          <span id="mr-window-help">${titleInfo('浏览器窗口', '记录本人成功连接的浏览器。续费套餐是此次打开窗口时所选的套餐。', 'mr-window-info')}</span>
          <button class="tab" type="button" role="tab" id="bit-address-heading" aria-controls="mr-address-panel" aria-selected="false" tabindex="-1">地址管理</button>
          <span id="mr-address-help" hidden>${titleInfo('地址管理', '生成美国账单地址模板，复制成功后移至已使用。', 'mr-address-info')}</span>
        </div><div class="mr-list-tools">
          <button type="button" id="mr-search-toggle" class="button icon-button" aria-label="展开搜索" aria-expanded="false">${A.icon('search')}</button>
          <input class="input" id="mr-window-search" type="search" data-auto-search maxlength="320" aria-label="搜索邮箱或备注" placeholder="搜索邮箱或备注">
          <form id="mr-address-search-form" hidden><input class="input" type="search" id="mr-address-search" maxlength="80" aria-label="搜索街道地址" placeholder="搜索街道地址"><button class="button" type="submit">查询</button></form>
          <button class="button icon-button" id="mr-search-close" type="button" aria-label="收起搜索" hidden>×</button>
          <button type="button" id="mr-refresh" class="button icon-button" aria-label="刷新" title="刷新">${A.icon('refresh')}</button>
        </div></header>
        <div class="panel-body bit-renewals" role="tabpanel" aria-labelledby="mr-window-tab" id="mr-window-panel">
          <div id="mr-list-message" role="status"></div>
          <div class="mr-table-scroll" data-pagination-rows><table class="bit-renewal-records mr-records" aria-label="浏览器窗口记录"><thead><tr><th>账号邮箱</th><th>续费套餐</th><th>备注</th><th>操作</th></tr></thead><tbody></tbody></table></div>
          <div id="mr-pagination"></div>
          <div class="mr-history">${button('历史登记', 'ops-manual-history')}</div>
        </div><div id="mr-address-panel" role="tabpanel" aria-labelledby="bit-address-heading" hidden></div>
      </section></div>`;
  }

  function mount(root) {
    if (active?.root === root) return;
    unmount();
    const life = new AbortController();
    const el = id => root.querySelector('#' + id);
    const on = (node, name, listener) => node.addEventListener(name, listener, { signal: life.signal });
    const message = (id, text) => {
      el(id).textContent = text;
    };
    const current = () => active?.life === life && root.isConnected && A.state.route === 'recharge/start';
    let activePane = 'windows',
      addressMounted = Boolean(el('bit-addresses-panel'));
    let account = '',
      restored = '',
      notesEdited = false,
      routesReady = false;
    let countries = {},
      ticket = null,
      ticketTimer,
      inputVersion = 0,
      routeVersion = 0,
      probeVersion = 0;
    let busyProbe = false,
      busyLaunch = false,
      releasing = false,
      slotKnown = false,
      legacyBlocked = false,
      slot = null,
      slotVersion = 0,
      slotTimer,
      checkingSlot = false,
      leaving = false;
    let page = Number(root.dataset.windowPage) || 1,
      pageSize = Number(root.dataset.windowSize) || window.IDPagination.defaultPageSize,
      listVersion = 0,
      rows = [];

    async function request(path, method = 'GET', data) {
      const res = await fetch(endpoint + path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.any([life.signal, AbortSignal.timeout(method === 'GET' ? 15000 : 90000)]),
        ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {})
      });
      const value = await res.json().catch(() => ({}));
      if (!res.ok)
        throw Object.assign(new Error(value.error || '请求失败，请重试。'), { status: res.status });
      return value;
    }
    function controls() {
      el('mr-plan').disabled = busyLaunch;
      el('mr-proxy').disabled = busyLaunch || !routesReady || !el('mr-plan').value;
      for (const id of ['mr-json', 'mr-notes']) el(id).readOnly = busyLaunch;
      for (const id of ['mr-clear', 'mr-paste']) el(id).disabled = busyLaunch;
      el('mr-copy').disabled = !account;
      el('mr-probe').disabled = busyProbe || busyLaunch || !routesReady || !account || !el('mr-plan').value;
      el('mr-launch').disabled = !ticket || busyLaunch || !slotKnown || checkingSlot || Boolean(slot);
      el('mr-probe').textContent = busyProbe ? '测速中…' : ticket ? '重新测速' : '一键测速';
      el('mr-launch').textContent = busyLaunch ? '正在打开…' : '打开浏览器';
      el('mr-release').disabled = el('mr-resume').disabled = releasing || checkingSlot || busyLaunch;
      el('mr-legacy-release').disabled = !account || releasing || checkingSlot || busyLaunch;
      root.setAttribute('aria-busy', String(busyLaunch));
    }
    function resetProbe(text = '请选择套餐并测速。') {
      clearTimeout(ticketTimer);
      ticket = null;
      busyProbe = false;
      probeVersion++;
      message('mr-result', text);
      controls();
    }
    function readAccount() {
      const raw = el('mr-json').value;
      let email = restored,
        error = '';
      if (raw.trim()) {
        try {
          if (new TextEncoder().encode(raw).length > 65_000) throw new RangeError();
          const value = JSON.parse(raw)?.user?.email;
          email = typeof value === 'string' ? value.trim().toLowerCase() : '';
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
            email = '';
            error = '授权 JSON 缺少有效邮箱。';
          }
        } catch (e) {
          email = '';
          error =
            e instanceof RangeError
              ? '请粘贴 65 KB 以内的单账号授权 JSON。'
              : 'JSON 格式无效，请粘贴完整内容。';
        }
      }
      if (account !== email) {
        el('mr-notes').value = rows.find(row => row.email === email)?.notes || '';
        notesEdited = false;
        el('mr-proxy').value = 'auto';
      }
      account = email;
      message('mr-email', account || '—');
      message('mr-auth-message', error);
      resetProbe();
    }
    function clearEntry() {
      inputVersion++;
      restored = '';
      el('mr-json').value = '';
      el('mr-notes').value = '';
      notesEdited = false;
      readAccount();
    }
    function countryText(code) {
      return [countries[code], code].filter(Boolean).join(' ') || '—';
    }
    async function loadRoutes(plan = el('mr-plan').value) {
      const version = ++routeVersion;
      routesReady = false;
      const planSelect = el('mr-plan');
      planSelect.value = Object.hasOwn(labels, plan) ? plan : '';
      plan = planSelect.value;
      resetProbe();
      el('mr-proxy').replaceChildren(new Option('自动选择最快线路', 'auto'));
      message('mr-country', plan ? '正在读取…' : '—');
      message('mr-route-error', '正在读取套餐线路…');
      el('mr-reload-routes').hidden = true;
      try {
        const data = await request('routes' + (plan ? '?plan=' + encodeURIComponent(plan) : ''));
        if (!current() || version !== routeVersion) return;
        if (!data.plans || !Array.isArray(data.choices)) throw new Error('未能读取套餐线路。');
        if (plan && !Object.hasOwn(data.plans, plan)) throw new Error('该套餐未配置执行国家。');
        countries = data.countries || {};
        message('mr-country', countryText(data.plans[plan]));
        for (const row of data.choices)
          el('mr-proxy').add(
            new Option(
              [row.name, row.protocol?.toUpperCase(), row.referenceIp && '参考 ' + row.referenceIp].filter(Boolean).join(' · '),
              String(row.id)
            )
          );
        routesReady = true;
        message('mr-route-error', '');
      } catch (err) {
        if (!current() || version !== routeVersion) return;
        message('mr-country', plan ? '暂不可用' : '—');
        message('mr-route-error', err.status === 503 ? '线路服务暂不可用，恢复后可测速。' : err.message);
        el('mr-reload-routes').hidden = false;
      }
      controls();
    }
    function showSlot(error = '') {
      el('mr-occupancy').hidden = slotKnown && !slot && !error;
      message('mr-occupied-text', error || (slot ? '正在使用 · ' + slot.email : '正在核对浏览器占用…'));
      el('mr-release').hidden = el('mr-resume').hidden = !slot || !slotKnown;
      el('mr-reload-slot').hidden = !error;
      el('mr-legacy-help').hidden = el('mr-legacy-release').hidden = !legacyBlocked;
      controls();
    }
    function scheduleSlotCheck() {
      clearTimeout(slotTimer);
      if (!current() || (!slot && !legacyBlocked) || leaving || document.hidden || busyLaunch || releasing)
        return;
      const delay = Number(slot?.recheckAfterMs);
      slotTimer = setTimeout(
        occupancy,
        Number.isFinite(delay) ? Math.min(15000, Math.max(1000, delay)) : 15000
      );
    }
    async function occupancy() {
      if (!current() || checkingSlot || leaving || document.hidden || releasing || busyLaunch) return;
      clearTimeout(slotTimer);
      checkingSlot = true;
      const version = ++slotVersion;
      if (!slotKnown) showSlot();
      else controls();
      try {
        const data = await request('occupancy');
        if (!current() || version !== slotVersion) return;
        if (!Object.hasOwn(data, 'active')) throw new Error('无法确认占用，请重试。');
        slot = data.active;
        legacyBlocked = false;
        slotKnown = true;
        showSlot();
      } catch (err) {
        if (current() && version === slotVersion) {
          slotKnown = false;
          legacyBlocked = err.status === 423;
          if (legacyBlocked) slot = null;
          showSlot(err.message);
        }
      } finally {
        if (current() && version === slotVersion) {
          checkingSlot = false;
          controls();
          scheduleSlotCheck();
        }
      }
    }
    async function release(held, legacyEmail) {
      if (!current() || releasing) return;
      if (legacyEmail ? !legacyBlocked || account !== legacyEmail : !slotKnown || slot?.runId !== held.runId)
        return;
      clearTimeout(slotTimer);
      slotVersion++;
      checkingSlot = false;
      releasing = true;
      showSlot('正在关闭工作区…');
      try {
        if (legacyEmail) await request('release-legacy', 'POST', { email: legacyEmail });
        else await request('release', 'POST', { id: held.id, runId: held.runId });
        releasing = false;
        if (current()) await occupancy();
      } catch (err) {
        if (current()) {
          slotKnown = false;
          showSlot(err.message);
        }
      } finally {
        releasing = false;
        if (current()) {
          controls();
          scheduleSlotCheck();
        }
      }
    }
    function openViewer(url) {
      if (typeof url !== 'string' || !viewerPath.test(url))
        throw new Error('未收到有效的浏览器连接，请核对当前占用后重试。');
      busyLaunch = true;
      clearEntry();
      window.location.assign(url);
    }
    function resume() {
      if (!slotKnown || !slot || releasing || checkingSlot || busyLaunch) return;
      try {
        openViewer(slot.viewerUrl);
      } catch (err) {
        showSlot(err.message);
      }
    }
    async function probe() {
      if (el('mr-probe').disabled) return;
      resetProbe('正在测速并核对实际出口…');
      const version = probeVersion;
      busyProbe = true;
      controls();
      try {
        const data = await request('probe', 'POST', {
          email: account,
          plan: el('mr-plan').value,
          proxyId: el('mr-proxy').value
        });
        if (!current() || probeVersion !== version) return;
        if (!data.ticket || !data.ip || !data.countryCode || !Number.isFinite(data.latencyMs))
          throw new Error('测速结果不完整，请重新测速。');
        ticket = data.ticket;
        message(
          'mr-result',
          [data.name, data.protocol?.toUpperCase(), countryText(data.countryCode), data.ip, data.latencyMs + ' ms']
            .filter(Boolean)
            .join(' · ')
        );
        if (data.expiresAt) {
          const expiry = typeof data.expiresAt === 'number' ? data.expiresAt : Date.parse(data.expiresAt);
          if (Number.isFinite(expiry))
            ticketTimer = setTimeout(
              () => {
                if (current() && probeVersion === version && !busyLaunch)
                  resetProbe('测速结果已过期，请重新测速。');
              },
              Math.max(0, expiry - Date.now())
            );
        }
      } catch (err) {
        if (current() && probeVersion === version) resetProbe(err.message);
      } finally {
        if (current() && probeVersion === version) {
          busyProbe = false;
          controls();
        }
      }
    }
    async function launch() {
      if (el('mr-launch').disabled) return;
      const selected = ticket,
        version = inputVersion;
      ticket = null;
      busyLaunch = true;
      controls();
      message('mr-result', '正在复核测速出口并打开浏览器…');
      try {
        const data = await request('launch', 'POST', {
          email: account,
          plan: el('mr-plan').value,
          ticket: selected,
          ...(notesEdited ? { notes: el('mr-notes').value } : {})
        });
        if (current() && version === inputVersion) openViewer(data.viewerUrl);
      } catch (err) {
        if (current() && version === inputVersion) {
          busyLaunch = false;
          resetProbe(err.message);
          await occupancy();
        }
      }
    }
    async function list() {
      const serial = ++listVersion;
      if (activePane !== 'windows') return;
      const query = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        search: window.IDSearchInput.value(el('mr-window-search')).trim()
      });
      message('mr-list-message', '正在读取窗口记录…');
      try {
        const result = await request('windows?' + query);
        if (!current() || serial !== listVersion || activePane !== 'windows') return;
        if (!Array.isArray(result.items)) throw new Error('窗口记录未能读取，请刷新重试。');
        const pagingChanged =
          page !== result.page ||
          pageSize !== result.pageSize ||
          root.querySelector('.mr-table-scroll').dataset.query !== query.toString();
        rows = result.items;
        page = result.page;
        pageSize = result.pageSize;
        root.querySelector('.mr-records tbody').innerHTML = rows.length
          ? rows
              .map(row => {
                const time = A.modules.bitbrowserAddresses.formatOpenedAt(row.lastOpenedAt);
                return `<tr><td><strong>${esc(row.email)}</strong><small>最近打开 · ${esc(time)}</small></td>
          <td data-label="套餐">${esc(labels[row.plan] || row.plan)}</td><td data-label="备注"><span class="mr-note">${esc(row.notes || '—')}</span></td>
          <td><div class="mr-row-actions"><button type="button" class="text-button" data-window-open="${esc(row.id)}" aria-label="打开浏览器 ${esc(row.email)}">打开</button>
          <button type="button" class="text-button" data-window-more="${esc(row.id)}" aria-label="更多操作 ${esc(row.email)}" aria-haspopup="menu">更多</button></div></td></tr>`;
              })
              .join('')
          : `<tr><td class="bit-renewal-empty" colspan="4">${query.get('search') ? '没有符合条件的窗口记录' : '暂无浏览器窗口记录'}</td></tr>`;
        el('mr-pagination').innerHTML = window.IDPagination.render({
          id: 'manual-browser-windows',
          page,
          pageSize,
          total: result.total
        });
        const viewport = root.querySelector('.mr-table-scroll');
        viewport.dataset.query = query.toString();
        if (pagingChanged) viewport.scrollTop = 0;
        message('mr-list-message', '');
      } catch (err) {
        if (current() && serial === listVersion && activePane === 'windows') {
          message('mr-list-message', err.message);
          return false;
        }
      }
    }
    function openRecord(row) {
      if (busyLaunch) return;
      if (slotKnown && slot?.email === row.email) return resume();
      inputVersion++;
      restored = row.email;
      el('mr-json').value = '';
      readAccount();
      el('mr-notes').value = row.notes;
      notesEdited = false;
      void loadRoutes(row.plan);
      message('mr-auth-message', '已选原窗口账号，请测速后打开。');
      el('mr-probe').scrollIntoView({ block: 'center' });
    }
    function edit(row) {
      A.openDrawer(
        '修改窗口备注',
        '备注仅保存在此窗口记录中。',
        `<form class="mr-form" id="mr-edit-form"><strong>${esc(row.email)}</strong><label class="mr-field">备注（选填）<textarea class="input" name="notes" rows="4" maxlength="2000">${esc(row.notes || '')}</textarea></label>
        <button class="button primary" type="submit">保存备注</button><div role="status"></div></form>`,
        '',
        'manual-browser-note'
      );
      const form = document.getElementById('mr-edit-form');
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const submit = form.querySelector('button'),
          note = form.elements.notes;
        if (submit.disabled || !current()) return;
        submit.disabled = note.readOnly = true;
        try {
          await request('window', 'PATCH', { id: row.id, revision: row.revision, notes: note.value });
          if (!current()) return;
          if (account === row.email && !notesEdited) el('mr-notes').value = note.value;
          if (form.isConnected) A.closeDrawer();
          A.notify('窗口备注已保存');
          await list();
        } catch (err) {
          if (form.isConnected) form.querySelector('[role="status"]').textContent = err.message;
          if (err.status === 409 && current()) await list();
        } finally {
          submit.disabled = note.readOnly = false;
        }
      });
    }
    async function remove(row) {
      if (!current()) return;
      try {
        await request('window', 'DELETE', { id: row.id, revision: row.revision });
        if (current()) {
          A.notify('窗口记录已删除');
          await list();
        }
      } catch (err) {
        if (current()) {
          await list();
          message('mr-list-message', err.message);
        }
      }
    }
    function recordMenu(trigger, row) {
      A.openActionMenu(
        trigger,
        button('修改备注', 'mr-edit-note') + button('删除记录', 'mr-delete', 'danger'),
        {
          label: '窗口操作',
          onSelect: choice => {
            if (!current()) return;
            if (choice.dataset.action === 'mr-edit-note') edit(row);
            else
              A.confirmAction(
                '删除窗口记录',
                `将从本人列表移除 ${row.email}。浏览器资料和账号将保留。`,
                () => void remove(row),
                '删除记录'
              );
          }
        }
      );
    }
    function searchExpanded(open) {
      root.querySelector('.mr-bar').classList.toggle('mr-searching', open);
      el('mr-search-toggle').setAttribute('aria-expanded', String(open));
      el('mr-search-close').hidden = !open;
      if (open) (activePane === 'windows' ? el('mr-window-search') : el('mr-address-search')).focus();
    }
    function pane(name) {
      const windows = name === 'windows';
      activePane = name;
      listVersion++;
      searchExpanded(false);
      for (const [id, selected] of [
        ['mr-window-tab', windows],
        ['bit-address-heading', !windows]
      ]) {
        const node = el(id);
        node.classList.toggle('active', selected);
        node.setAttribute('aria-selected', String(selected));
        node.tabIndex = selected ? 0 : -1;
      }
      root
        .querySelector('.mr-management')
        .setAttribute('aria-labelledby', windows ? 'mr-window-tab' : 'bit-address-heading');
      el('mr-window-panel').hidden = el('mr-window-search').hidden = el('mr-window-help').hidden = !windows;
      el('mr-address-panel').hidden =
        el('mr-address-help').hidden =
        el('mr-address-search-form').hidden =
          windows;
      if (windows) {
        window.IDSearchInput.restore(root);
        void list();
      } else {
        window.IDSearchInput.suspend(el('mr-window-search').parentElement);
        if (!addressMounted) {
          addressMounted = true;
          el('mr-address-search').value = A.modules.bitbrowserAddresses.addressSearchDraft;
          A.modules.bitbrowserAddresses.mount(el('mr-address-panel'), { addressOnly: true });
        }
      }
    }

    active = {
      root,
      life,
      refresh: list,
      close() {
        root.dataset.windowPage = String(page);
        root.dataset.windowSize = String(pageSize);
        clearTimeout(slotTimer);
        clearTimeout(ticketTimer);
        life.abort();
        inputVersion++;
        probeVersion++;
        slotVersion++;
        routeVersion++;
        listVersion++;
        el('mr-json').value = '';
        el('mr-notes').value = '';
        message('mr-email', '—');
        ticket = null;
      }
    };
    on(el('mr-json'), 'input', () => {
      inputVersion++;
      restored = '';
      readAccount();
    });
    on(el('mr-clear'), 'click', () => {
      clearEntry();
      el('mr-json').focus();
    });
    on(el('mr-paste'), 'click', async () => {
      const version = ++inputVersion;
      try {
        const value = await navigator.clipboard.readText();
        if (current() && version === inputVersion && !busyLaunch) {
          restored = '';
          el('mr-json').value = value;
          readAccount();
        }
      } catch {
        if (current() && version === inputVersion) {
          message('mr-auth-message', '请在输入框使用系统粘贴。');
          el('mr-json').focus();
        }
      }
    });
    on(el('mr-copy'), 'click', async () => {
      const version = inputVersion;
      const copied = await A.copyText(account, '邮箱已复制', {
        current: () => current() && version === inputVersion
      });
      if (current() && version === inputVersion)
        message('mr-auth-message', copied ? '邮箱已复制。' : '请选中邮箱后使用系统复制。');
    });
    on(el('mr-notes'), 'input', () => {
      notesEdited = true;
    });
    on(el('mr-plan'), 'change', () => void loadRoutes());
    on(el('mr-proxy'), 'change', () => resetProbe('线路已更改，请重新测速。'));
    on(el('mr-reload-routes'), 'click', () => void loadRoutes());
    on(el('mr-probe'), 'click', () => void probe());
    on(el('mr-launch'), 'click', () => void launch());
    on(el('mr-reload-slot'), 'click', () => void occupancy());
    on(el('mr-resume'), 'click', resume);
    on(el('mr-legacy-release'), 'click', () => {
      const email = account;
      if (!legacyBlocked || !email || releasing || checkingSlot) return;
      A.confirmAction(
        '结束旧版充值窗口',
        `将尝试关闭本人旧版充值窗口 ${email}，并断开该窗口的连接。`,
        () => void release(null, email),
        '按旧账号结束'
      );
    });
    on(el('mr-release'), 'click', () => {
      const held = slot;
      if (held)
        A.confirmAction(
          '结束并释放工作区',
          `将关闭 ${held.email} 的当前浏览器，并断开此窗口的其他连接。`,
          () => void release(held),
          '结束并释放'
        );
    });
    on(el('mr-window-tab'), 'click', () => pane('windows'));
    on(el('bit-address-heading'), 'click', () => pane('address'));
    on(el('mr-jump'), 'click', () => {
      pane('windows');
      el('mr-window-tab').focus();
    });
    on(el('mr-search-toggle'), 'click', () => searchExpanded(true));
    on(el('mr-search-close'), 'click', () => {
      searchExpanded(false);
      el('mr-search-toggle').focus();
    });
    on(root.querySelector('.mr-bar'), 'keydown', e => {
      if (e.key === 'Escape' && root.querySelector('.mr-bar').classList.contains('mr-searching'))
        el('mr-search-close').click();
    });
    on(el('mr-window-search'), 'input', () => {
      page = 1;
      void list();
    });
    on(el('mr-address-search'), 'input', e => {
      A.modules.bitbrowserAddresses.addressSearchDraft = e.target.value;
    });
    on(el('mr-address-search-form'), 'submit', e => {
      e.preventDefault();
      void A.modules.bitbrowserAddresses.searchAddress(el('mr-address-search').value);
    });
    on(el('mr-refresh'), 'click', () => {
      void occupancy();
      if (activePane === 'windows') void list();
      else void A.modules.bitbrowserAddresses.refreshAddress();
    });
    on(el('mr-window-panel'), 'id-pagination-change', ({ detail }) => {
      if (detail.id === 'manual-browser-windows') {
        page = detail.page;
        pageSize = detail.pageSize;
        void list();
      }
    });
    on(el('mr-window-panel'), 'click', e => {
      const trigger = e.target.closest('[data-window-open], [data-window-more]');
      if (!trigger) return;
      const row = rows.find(
        item => String(item.id) === (trigger.dataset.windowOpen || trigger.dataset.windowMore)
      );
      if (row) {
        if (trigger.hasAttribute('data-window-open')) openRecord(row);
        else recordMenu(trigger, row);
      }
    });
    on(window, 'focus', () => void occupancy());
    on(document, 'visibilitychange', () => {
      if (document.hidden) clearTimeout(slotTimer);
      else void occupancy();
    });
    on(window, 'pagehide', () => {
      leaving = true;
      clearTimeout(slotTimer);
      slotVersion++;
      checkingSlot = false;
      clearEntry();
      busyLaunch = false;
      controls();
    });
    on(window, 'pageshow', e => {
      if (e.persisted && current()) {
        leaving = false;
        busyLaunch = false;
        clearEntry();
        void occupancy();
        void loadRoutes();
        void list();
      }
    });
    void loadRoutes();
    void occupancy();
    pane(el('mr-address-panel').hidden ? 'windows' : 'address');
    if (activePane === 'address' && addressMounted) void A.modules.bitbrowserAddresses.refreshAddress();
  }
  function unmount() {
    active?.close();
    active = undefined;
  }
  A.modules.manualRecharge = { render, mount, unmount };
  window.IDDesignModules.push({
    id: 'manual-recharge-windows',
    matches: () => false,
    onDataChanges(scopes) {
      if (scopes.includes('manual-browser-windows') && active) return active.refresh();
    }
  });
})();
