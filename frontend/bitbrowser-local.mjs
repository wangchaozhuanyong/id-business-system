import { initializeExecutionProxies } from '/assets/bitbrowser/proxies.mjs';
import {
  BIT_BROWSER_AUTHORIZATION_MAX_BYTES,
  parseBitBrowserAuthorization
} from '/assets/bitbrowser/authorization.mjs';
import { BitBrowserCatalogError, readBitBrowserCatalog } from '/assets/bitbrowser/catalog.mjs';
import {
  BIT_BROWSER_LOGIN_DEFAULTS,
  BitBrowserLoginError,
  runBitBrowserJsonLogin
} from '/assets/bitbrowser/login/index.mjs';

const get = (id) => document.getElementById(id);
const loginForm = get('bit-login-form');
const loginFields = get('bit-login-fields');
const startButton = get('bit-start-login');
const cancelButton = get('bit-cancel-login');
const loginResult = get('bit-login-result');
const jsonInput = get('bit-authorization-json');
const fileInput = get('bit-authorization-file');
const authorizationResult = get('bit-authorization-result');
const windowName = get('bit-window-name');
const urlInput = get('bit-local-url');
const tokenInput = get('bit-local-token');
const proxyUserInput = get('bit-proxy-user');
const proxyPasswordInput = get('bit-proxy-password');
const groupSelect = get('bit-local-group');
const tagSelect = get('bit-local-tag');
const catalogResult = get('bit-catalog-result');
const proxyMode = get('bit-proxy-mode');
const settings = get('bit-connection-settings');
const catalogButton = get('bit-check-connection');
const profileChoice = get('bit-connection-profile');
const defaultProfileButton = get('bit-default-connection');
const defaultProfileResult = get('bit-default-connection-result');
const profileName = get('bit-connection-name');
const accountName = get('bit-account-name');
const saveProfileButton = get('bit-save-connection');
const addProfileButton = get('bit-add-connection');
const reloadProfileButton = get('bit-reload-connections');
const profileResult = get('bit-profile-result');
const profileControls = {
  coreVersion: get('bit-core'),
  proxyMode,
  proxyType: get('bit-proxy-type'),
  expectedCountryCode: get('bit-proxy-country'),
  staticHost: get('bit-proxy-host'),
  staticPort: get('bit-proxy-port'),
  sessionWaitMinutes: get('bit-session-wait'),
  sessionRetryLimit: get('bit-session-retries')
};
const defaultConnection = {
  name: '',
  accountName: '',
  url: urlInput.defaultValue,
  groupName: 'gpt账号注册',
  tagName: '申请gpt',
  coreVersion: BIT_BROWSER_LOGIN_DEFAULTS.coreVersion,
  proxyMode: BIT_BROWSER_LOGIN_DEFAULTS.proxyMode,
  proxyType: 'http',
  expectedCountryCode: '',
  staticHost: '',
  staticPort: BIT_BROWSER_LOGIN_DEFAULTS.staticPort,
  sessionWaitMinutes: BIT_BROWSER_LOGIN_DEFAULTS.sessionWaitMinutes,
  sessionRetryLimit: BIT_BROWSER_LOGIN_DEFAULTS.sessionRetryLimit
};
const profilesEnabled = document.body.hasAttribute('data-connection-profiles');

let credential = '';
let authorizationCheckId = 0;
let activeCatalogCheck;
let activeLogin;
let moduleVisible = true;
let connectionRestoreId = 0;
let connectionRestoreController;
const pendingDataChanges = new Set();
async function refreshLiveChoices() {
  if (activeLogin || activeCatalogCheck || profileBusy || savingProfileDefault || document.hidden || !moduleVisible) return;
  if (pendingDataChanges.has('bitbrowser-connections') && settings.hidden) {
    pendingDataChanges.delete('bitbrowser-connections');
    await loadProfiles();
  }
  if (pendingDataChanges.has('bitbrowser-proxies') && !executionProxies?.editing()) {
    pendingDataChanges.delete('bitbrowser-proxies');
    await executionProxies?.refresh();
  }
}
document.documentElement.dataset.rechargeNavigationLocked = 'false';
function setLoginLock(locked) {
  document.documentElement.dataset.rechargeNavigationLocked = String(locked);
}
let catalogReady = false;
let profileData;
let profileBusy = false;
let savingProfileDefault = false;
let profileConflict = false;
let selectedProfileId = '';
let loadedProxyEndpoint = '';
let groupPreference = defaultConnection.groupName;
let tagPreference = defaultConnection.tagName;

let executionProxies;
let draftBridge;
try {
  if (window.parent !== window && window.parent.location.origin === location.origin)
    draftBridge = window.parent.IDRechargeDrafts;
} catch { /* Standalone login does not create another draft store. */ }
const connectionDraftFields = [profileName, accountName, urlInput, ...Object.values(profileControls)];
const readConnectionDrafts = () => draftBridge?.read('bit-local') || {};
const draftPrefix = () => `profile/${selectedProfileId || 'manual'}/`;
function restoreConnectionDraft() {
  const values = readConnectionDrafts();
  const prefix = draftPrefix();
  for (const control of connectionDraftFields)
    if (Object.hasOwn(values, prefix + control.id)) control.value = values[prefix + control.id];
  groupPreference = values[prefix + 'groupPreference'] ?? groupPreference;
  tagPreference = values[prefix + 'tagPreference'] ?? tagPreference;
}
function captureConnectionDraft(event) {
  if (!draftBridge || !event.isTrusted) return;
  const control = event.target;
  const values = readConnectionDrafts();
  const prefix = draftPrefix();
  if (connectionDraftFields.includes(control)) values[prefix + control.id] = control.value;
  else if (control === groupSelect && control.value) values[prefix + 'groupPreference'] = control.selectedOptions[0].text;
  else if (control === tagSelect && control.value) values[prefix + 'tagPreference'] = control.selectedOptions[0].text;
  else return;
  if (profileData && !Object.hasOwn(values, prefix + 'version'))
    values[prefix + 'version'] = String(profileData.version);
  draftBridge.write('bit-local', values);
}
loginForm.addEventListener('input', captureConnectionDraft);
loginForm.addEventListener('change', captureConnectionDraft);

function updateStartButton() {
  const profilePending = profileBusy || savingProfileDefault;
  startButton.disabled =
    !executionProxies?.ready() ||
    !credential ||
    !groupSelect.value ||
    !tagSelect.value ||
    !tokenInput.value ||
    Boolean(activeLogin || activeCatalogCheck || profilePending);
  catalogButton.disabled = Boolean(activeLogin || activeCatalogCheck || profilePending);
  saveProfileButton.disabled =
    !profileData ||
    profilePending ||
    profileConflict ||
    !catalogReady ||
    !groupSelect.value ||
    !tagSelect.value ||
    Boolean(activeLogin);
  addProfileButton.disabled = !profileData || profilePending || Boolean(activeLogin);
  profileChoice.disabled = !profileData || profilePending || Boolean(activeLogin);
  defaultProfileButton.disabled = profileChoice.disabled || !selectedProfileId;
  defaultProfileButton.textContent = selectedProfileId && selectedProfileId === profileData?.defaultId
    ? '取消默认' : '设为默认';
  get('bit-toggle-connection').disabled = Boolean(activeLogin);
  for (const id of ['bit-tab-workbench', 'bit-tab-login', 'bit-tab-library', 'bit-show-library']) {
    const el = get(id);
    if (el) el.disabled = Boolean(activeLogin);
  }
  if (pendingDataChanges.size) queueMicrotask(refreshLiveChoices);
}

const workspaceNames = ['workbench', 'login', 'library'];

function showWorkspace(view, focus = false) {
  if (activeLogin) return;
  const targetView = workspaceNames.includes(view) ? view : 'workbench';
  for (const name of workspaceNames) {
    const selected = targetView === name;
    const button = get('bit-tab-' + name);
    if (button) {
      button.setAttribute('aria-selected', String(selected));
      button.classList.toggle('active', selected);
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    }
    const panel = get('bit-' + name + '-panel');
    if (panel) panel.hidden = !selected;
  }
  const values = readConnectionDrafts();
  values.workspace = targetView;
  draftBridge?.write('bit-local', values);
}
for (const name of workspaceNames) {
  get('bit-tab-' + name)?.addEventListener('click', () => showWorkspace(name));
  get('bit-tab-' + name)?.addEventListener('keydown', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const currentIndex = workspaceNames.indexOf(name);
      let nextIndex = 0;
      if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = workspaceNames.length - 1;
      else if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % workspaceNames.length;
      else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + workspaceNames.length) % workspaceNames.length;
      showWorkspace(workspaceNames[nextIndex], true);
    }
  });
}
get('bit-show-library')?.addEventListener('click', () => showWorkspace('library', true));
const savedWorkspace = readConnectionDrafts().workspace;
const defaultInitialWorkspace = savedWorkspace || (document.body.hasAttribute('data-connection-profiles') ? 'login' : 'workbench');
showWorkspace(defaultInitialWorkspace);
function initializeNativeWorkbench() {
  const wbJsonInput = get('wb-json-input');
  const wbJsonStatus = get('wb-json-status');
  const wbProxySummary = get('wb-proxy-summary');
  const wbProxyUrl = get('wb-proxy-url');
  const wbNotesInput = get('wb-notes-input');
  const wbSaveAndOpen = get('wb-save-and-open');
  const wbSaveOnly = get('wb-save-only');
  const wbClearInput = get('wb-clear-input');
  const wbRefreshList = get('wb-refresh-list');
  const wbSearchInput = get('wb-search-input');
  const wbFilterStatus = get('wb-filter-status');
  const wbListCount = get('wb-list-count');
  const wbTbody = get('wb-accounts-tbody');

  const wbUpdateDialog = get('wb-update-json-dialog');
  const wbUpdateEmail = get('wb-update-json-email');
  const wbUpdateTextarea = get('wb-update-json-textarea');
  const wbUpdateStatus = get('wb-update-json-status');
  const wbUpdateDismiss = get('wb-update-json-dismiss');
  const wbUpdateCancel = get('wb-update-json-cancel');
  const wbUpdateSaveOnly = get('wb-update-json-save-only');
  const wbUpdateSaveAndLaunch = get('wb-update-json-save-and-launch');

  if (!wbJsonInput || !wbTbody) return;

  let accounts = [];

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function parseInputJson() {
    const raw = wbJsonInput.value.trim();
    if (!raw) {
      wbJsonStatus.textContent = '等待输入';
      wbJsonStatus.className = 'field-help';
      return null;
    }
    try {
      const data = JSON.parse(raw);
      const email = data.user?.email || '';
      const plan = data.account?.planType || data.account?.plan_type || 'free';
      const hasToken = Boolean(data.sessionToken || data.session_token);
      const hasDevice = Boolean(data.statsigContext?.deviceId || data.deviceId || data.device_id);
      if (!hasToken) {
        wbJsonStatus.textContent = '提示：JSON 中未发现 sessionToken';
        wbJsonStatus.className = 'field-help text-warning';
        return null;
      }
      wbJsonStatus.textContent = `✓ 已识别邮箱：${email || '未命名'} · 套餐：${plan}${hasDevice ? ' · 含设备指纹' : ''}`;
      wbJsonStatus.className = 'field-help text-success';
      return data;
    } catch {
      wbJsonStatus.textContent = '提示：当前内容不是合法的单账户 JSON 格式';
      wbJsonStatus.className = 'field-help text-warning';
      return null;
    }
  }

  wbJsonInput.addEventListener('input', parseInputJson);
  wbJsonInput.addEventListener('change', parseInputJson);

  wbClearInput?.addEventListener('click', () => {
    wbJsonInput.value = '';
    if (wbProxySummary) wbProxySummary.value = '';
    if (wbProxyUrl) wbProxyUrl.value = '';
    if (wbNotesInput) wbNotesInput.value = '';
    parseInputJson();
  });

  async function loadAccounts() {
    const search = wbSearchInput?.value.trim() || '';
    const status = wbFilterStatus?.value || '';
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (status) params.set('status', status);
      const res = await fetch(`/api/local/native-browser-workbench?${params.toString()}`, {
        cache: 'no-store'
      });
      if (!res.ok) throw new Error('读取数据表失败');
      const data = await res.json();
      accounts = data.items || [];
      renderTable();
    } catch (err) {
      wbTbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color: var(--text-error); padding: 18px;">加载数据表失败：${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function renderTable() {
    if (wbListCount) wbListCount.textContent = `共 ${accounts.length} 个账号`;
    if (!accounts.length) {
      wbTbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color: var(--text-secondary); padding: 24px;">暂无账号记录，请在上方录入</td></tr>`;
      return;
    }

    wbTbody.innerHTML = accounts
      .map((item) => {
        const statusMap = {
          pending_renewal: { text: '待续费', color: 'var(--tag-pending-color, #d97706)' },
          active: { text: '已开通', color: 'var(--tag-success-color, #16a34a)' },
          expired: { text: '授权过期', color: 'var(--tag-error-color, #dc2626)' }
        };
        const statusBadge = statusMap[item.status] || { text: item.status, color: 'var(--text-secondary)' };
        const runningBadge = item.isRunning
          ? `<span style="display:inline-block; margin-left: 4px; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; background: #22c55e20; color: #16a34a; border: 1px solid #22c55e40;">● 运行中</span>`
          : '';
        const openTime = item.lastOpenedAt
          ? new Date(item.lastOpenedAt).toLocaleString('zh-CN', {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            })
          : '未曾打开';

        return `
          <tr data-account-id="${escapeHtml(item.id)}">
            <td style="font-weight: 500;">
              <span class="wb-account-email" title="点击复制" style="cursor: pointer;">${escapeHtml(item.email)}</span>
            </td>
            <td><span class="badge">${escapeHtml(item.currentPlan.toUpperCase())}</span></td>
            <td>${escapeHtml(item.proxySummary)}</td>
            <td><span style="display:inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; background: ${statusBadge.color}18; color: ${statusBadge.color}; border: 1px solid ${statusBadge.color}40;">${escapeHtml(statusBadge.text)}</span>${runningBadge}</td>
            <td style="font-size: 13px; color: var(--text-secondary);">${escapeHtml(openTime)}</td>
            <td style="font-size: 13px;">${escapeHtml(item.renewalNotes || '—')}</td>
            <td style="text-align: right; white-space: nowrap;">
              ${item.isRunning
                ? `<button type="button" class="button button--small button--warning wb-btn-close" data-id="${escapeHtml(item.id)}" title="关闭浏览器并立即切断代理连接">关闭窗口</button>`
                : `<button type="button" class="button button--small button--primary wb-btn-launch" data-id="${escapeHtml(item.id)}">打开浏览器</button>`
              }
              <button type="button" class="button button--small wb-btn-update-json" data-id="${escapeHtml(item.id)}" data-email="${escapeHtml(item.email)}" title="会话过期时，更换最新授权 JSON">更换 JSON</button>
              <button type="button" class="button button--small wb-btn-mark-active" data-id="${escapeHtml(item.id)}" title="标记为已开通Plus">标记开通</button>
              <button type="button" class="button button--small button--danger wb-btn-delete" data-id="${escapeHtml(item.id)}">删除</button>
            </td>
          </tr>
        `;
      })
      .join('');

    wbTbody.querySelectorAll('.wb-account-email').forEach((el) => {
      el.addEventListener('click', () => {
        navigator.clipboard?.writeText(el.textContent.trim());
        const original = el.textContent;
        el.textContent = '✓ 已复制';
        setTimeout(() => {
          el.textContent = original;
        }, 1200);
      });
    });

    wbTbody.querySelectorAll('.wb-btn-launch').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        btn.disabled = true;
        btn.textContent = '启动中…';
        try {
          const res = await fetch('/api/local/native-browser-workbench?action=launch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
          });
          const result = await res.json();
          if (!res.ok) throw new Error(result.error || '拉起浏览器失败');
          alert('✓ 浏览器窗口已在屏幕前打开，请在窗口中手动点击续费');
          await loadAccounts();
        } catch (err) {
          alert(`启动失败: ${err.message}`);
        } finally {
          btn.disabled = false;
          btn.textContent = '打开浏览器';
        }
      });
    });

    wbTbody.querySelectorAll('.wb-btn-close').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        btn.disabled = true;
        btn.textContent = '关闭中…';
        try {
          const res = await fetch('/api/local/native-browser-workbench?action=close', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
          });
          const result = await res.json();
          if (!res.ok) throw new Error(result.error || '关闭浏览器失败');
          await loadAccounts();
        } catch (err) {
          alert(`关闭失败: ${err.message}`);
          btn.disabled = false;
          btn.textContent = '关闭窗口';
        }
      });
    });

    wbTbody.querySelectorAll('.wb-btn-mark-active').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        try {
          const res = await fetch('/api/local/native-browser-workbench?action=note', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id,
              status: 'active',
              currentPlan: 'plus',
              renewalNotes: '已完成 Plus 续费'
            })
          });
          if (!res.ok) throw new Error('更新状态失败');
          await loadAccounts();
        } catch (err) {
          alert(`操作失败: ${err.message}`);
        }
      });
    });

    wbTbody.querySelectorAll('.wb-btn-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (!confirm('确定要删除这条账号记录吗？')) return;
        try {
          const res = await fetch('/api/local/native-browser-workbench?action=delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
          });
          if (!res.ok) throw new Error('删除记录失败');
          await loadAccounts();
        } catch (err) {
          alert(`删除失败: ${err.message}`);
        }
      });
    });

    wbTbody.querySelectorAll('.wb-btn-update-json').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const email = btn.getAttribute('data-email');
        if (wbUpdateDialog) {
          wbUpdateDialog.dataset.accountId = id;
          if (wbUpdateEmail) wbUpdateEmail.value = email;
          if (wbUpdateTextarea) wbUpdateTextarea.value = '';
          if (wbUpdateStatus) {
            wbUpdateStatus.textContent = '请粘贴该账号最新的授权 JSON';
            wbUpdateStatus.className = 'field-help';
          }
          wbUpdateDialog.showModal();
        }
      });
    });
  }

  function closeUpdateDialog() {
    if (wbUpdateDialog?.open) wbUpdateDialog.close();
    if (wbUpdateTextarea) wbUpdateTextarea.value = '';
    if (wbUpdateStatus) {
      wbUpdateStatus.textContent = '请粘贴该账号最新的授权 JSON';
      wbUpdateStatus.className = 'field-help';
    }
  }

  wbUpdateDismiss?.addEventListener('click', closeUpdateDialog);
  wbUpdateCancel?.addEventListener('click', closeUpdateDialog);

  wbUpdateTextarea?.addEventListener('input', () => {
    const raw = wbUpdateTextarea.value.trim();
    if (!raw) {
      wbUpdateStatus.textContent = '请粘贴该账号最新的授权 JSON';
      wbUpdateStatus.className = 'field-help';
      return;
    }
    try {
      const data = JSON.parse(raw);
      const email = (data.user?.email || '').trim().toLowerCase();
      const hasToken = Boolean(data.sessionToken || data.session_token);
      const targetEmail = (wbUpdateEmail?.value || '').trim().toLowerCase();

      if (!hasToken) {
        wbUpdateStatus.textContent = '⚠️ 提示：JSON 中未发现有效 sessionToken';
        wbUpdateStatus.className = 'field-help text-warning';
        return;
      }
      if (email && targetEmail && email !== targetEmail) {
        wbUpdateStatus.textContent = `⚠️ 警告：JSON 邮箱 (${email}) 与目标账号 (${targetEmail}) 不一致`;
        wbUpdateStatus.className = 'field-help text-warning';
        return;
      }
      wbUpdateStatus.textContent = '✓ 凭据格式有效，与目标账号匹配';
      wbUpdateStatus.className = 'field-help text-success';
    } catch {
      wbUpdateStatus.textContent = '⚠️ 提示：JSON 格式无效，请粘贴完整内容';
      wbUpdateStatus.className = 'field-help text-warning';
    }
  });

  async function handleUpdateJson(autoLaunch = false) {
    const id = wbUpdateDialog?.dataset.accountId;
    const sessionJson = wbUpdateTextarea?.value.trim();
    if (!id || !sessionJson) {
      alert('请粘贴完整的单账户授权 JSON');
      return;
    }

    const btn = autoLaunch ? wbUpdateSaveAndLaunch : wbUpdateSaveOnly;
    if (btn) btn.disabled = true;

    try {
      const res = await fetch('/api/local/native-browser-workbench?action=update-json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, sessionJson, autoLaunch })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '更新凭据失败');

      closeUpdateDialog();
      if (autoLaunch) {
        alert('✓ 凭据已更新！浏览器窗口已在屏幕前打开，请在窗口中手动点击续费');
      } else {
        alert('✓ 凭据已成功更新');
      }
      await loadAccounts();
    } catch (err) {
      alert(`更新失败: ${err.message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  wbUpdateSaveOnly?.addEventListener('click', () => handleUpdateJson(false));
  wbUpdateSaveAndLaunch?.addEventListener('click', () => handleUpdateJson(true));

  async function saveAccount(andOpen = false) {
    const raw = wbJsonInput.value.trim();
    if (!raw) {
      alert('请先粘贴授权 JSON');
      wbJsonInput.focus();
      return;
    }

    const payload = {
      sessionJson: raw,
      proxySummary: wbProxySummary?.value.trim() || '',
      proxyUrl: wbProxyUrl?.value.trim() || '',
      renewalNotes: wbNotesInput?.value.trim() || ''
    };

    const targetBtn = andOpen ? wbSaveAndOpen : wbSaveOnly;
    if (targetBtn) {
      targetBtn.disabled = true;
      targetBtn.textContent = '正在保存…';
    }

    try {
      const res = await fetch('/api/local/native-browser-workbench', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '保存账号记录失败');

      if (andOpen && data.record?.id) {
        if (targetBtn) targetBtn.textContent = '正在拉起浏览器…';
        const launchRes = await fetch('/api/local/native-browser-workbench?action=launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: data.record.id })
        });
        const launchData = await launchRes.json();
        if (!launchRes.ok) throw new Error(launchData.error || '拉起浏览器失败');
        alert('✓ 账号已保存，专属 Chrome 窗口已成功打开！');
      } else {
        alert('✓ 账号已成功保存至数据表');
      }

      wbJsonInput.value = '';
      if (wbNotesInput) wbNotesInput.value = '';
      parseInputJson();
      await loadAccounts();
    } catch (err) {
      alert(`保存失败: ${err.message}`);
    } finally {
      if (targetBtn) {
        targetBtn.disabled = false;
        targetBtn.textContent = andOpen ? '保存并打开浏览器' : '仅保存到数据表';
      }
    }
  }

  wbSaveAndOpen?.addEventListener('click', () => saveAccount(true));
  wbSaveOnly?.addEventListener('click', () => saveAccount(false));
  wbRefreshList?.addEventListener('click', loadAccounts);
  wbSearchInput?.addEventListener('input', loadAccounts);
  wbFilterStatus?.addEventListener('change', loadAccounts);

  void loadAccounts();
}

initializeNativeWorkbench();
executionProxies = initializeExecutionProxies({ get, drafts: draftBridge, onChange: updateStartButton, locked: () => Boolean(activeLogin), onUse: () => showWorkspace('login'), connection: () => ({ url: urlInput.value, token: tokenInput.value }) });
void executionProxies.refresh();
get('bit-token-eye').addEventListener('click', () => {
  const visible = tokenInput.type === 'password';
  tokenInput.type = visible ? 'text' : 'password';
  get('bit-token-eye').setAttribute('aria-pressed', String(visible));
  get('bit-token-eye').setAttribute('aria-label', visible ? '隐藏本机接口密钥' : '查看本机接口密钥');
  get('bit-token-eye').title = visible ? '隐藏本机接口密钥' : '查看本机接口密钥';
});

function loadAuthorization(value) {
  credential = '';
  windowName.value = '';
  jsonInput.placeholder = '粘贴完整授权 JSON，将自动载入';
  authorizationResult.textContent = '';
  if (value) {
    try {
      const { email } = parseBitBrowserAuthorization(value);
      credential = value;
      jsonInput.value = '';
      jsonInput.placeholder = '授权已自动载入，可粘贴新 JSON 替换';
      authorizationResult.textContent = `授权已载入 · ${email}`;
      windowName.value = email;
    } catch {
      authorizationResult.textContent = '请粘贴完整有效的单账户授权 JSON（不超过 65 KB）。';
    }
  }
  updateStartButton();
}

get('bit-clear-authorization').addEventListener('click', () => {
  if (activeLogin) return;
  authorizationCheckId++;
  jsonInput.value = '';
  fileInput.value = '';
  loadAuthorization('');
  loginResult.textContent = '等待登录';
  jsonInput.focus();
});

jsonInput.addEventListener('input', () => {
  authorizationCheckId++;
  loadAuthorization(jsonInput.value);
});
jsonInput.addEventListener('paste', (event) => {
  const text = event.clipboardData?.getData('text/plain');
  if (!text) return;
  event.preventDefault();
  authorizationCheckId++;
  jsonInput.value = '';
  loadAuthorization(text);
});
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  const checkId = ++authorizationCheckId;
  jsonInput.value = '';
  loadAuthorization('');
  authorizationResult.textContent = '正在读取授权文件…';
  try {
    if (file.size > BIT_BROWSER_AUTHORIZATION_MAX_BYTES) {
      throw new Error('授权文件超过 65 KB');
    }
    const value = await file.text();
    if (checkId === authorizationCheckId) loadAuthorization(value);
  } catch {
    if (checkId === authorizationCheckId) {
      authorizationResult.textContent =
        '无法读取授权文件。请选择不超过 65 KB 的 JSON 或 TXT 文件。';
    }
  }
});

function clearCatalog() {
  activeCatalogCheck?.abort();
  activeCatalogCheck = undefined;
  catalogReady = false;
  groupSelect.replaceChildren(new Option('请先检测连接', ''));
  tagSelect.replaceChildren(new Option('请先检测连接', ''));
  groupSelect.disabled = true;
  tagSelect.disabled = true;
  catalogResult.textContent = '点击“检测连接”读取当前电脑的窗口分组和标签。';
  updateStartButton();
}

function fillChoices(select, choices, preferredName, previousChoice) {
  const counts = new Map();
  for (const { name } of choices) counts.set(name, (counts.get(name) || 0) + 1);
  const available = choices.filter(({ name }) => counts.get(name) === 1);
  const initial =
    available.find((choice) => choice.id === previousChoice) ||
    available.find((choice) => choice.name === preferredName) ||
    (available.length === 1 ? available[0] : undefined);
  const prompt = new Option(available.length ? '请选择' : '没有可用选项', '', false, !initial);
  prompt.disabled = true;
  select.replaceChildren(
    prompt,
    ...choices.map(({ name, id }) => {
      const duplicate = counts.get(name) > 1;
      const option = new Option(
        duplicate ? `${name}（重名）` : name,
        id,
        false,
        id === initial?.id
      );
      option.disabled = duplicate;
      return option;
    })
  );
  select.disabled = !available.length;
}

urlInput.addEventListener('input', () => {
  cancelConnectionRestore();
  tokenInput.value = '';
  clearCatalog();
});
tokenInput.addEventListener('input', () => { cancelConnectionRestore(); clearCatalog(); });
function updateCatalogStatus() {
  if (catalogReady) {
    catalogResult.textContent =
      groupSelect.disabled || tagSelect.disabled
        ? '已连接本机比特浏览器。请在比特客户端添加或区分窗口分组和标签后重新检测。'
        : groupSelect.value && tagSelect.value
          ? '已连接本机比特浏览器，窗口分组和标签已核对。'
          : '已连接本机比特浏览器，请选择窗口分组和标签。';
  }
  updateStartButton();
}
for (const control of [groupSelect, tagSelect]) {
  control.addEventListener('input', () => {
    if (groupSelect.value) groupPreference = groupSelect.selectedOptions[0].text;
    if (tagSelect.value) tagPreference = tagSelect.selectedOptions[0].text;
    updateCatalogStatus();
  });
}
proxyMode.addEventListener('change', () => {
  for (const row of document.querySelectorAll('[data-bit-proxy]')) {
    row.hidden = row.dataset.bitProxy !== proxyMode.value;
    row.querySelector('input').disabled = row.hidden;
  }
});
proxyMode.dispatchEvent(new Event('change'));

catalogButton.addEventListener('click', async () => {
  const previousGroup = groupSelect.value;
  const previousTag = tagSelect.value;
  clearCatalog();
  const check = new AbortController();
  activeCatalogCheck = check;
  updateStartButton();
  catalogResult.textContent = '正在读取窗口分组和标签…';
  try {
    const { groups, tags } = await readBitBrowserCatalog({
      url: urlInput.value,
      token: tokenInput.value,
      signal: check.signal
    });
    if (activeCatalogCheck !== check) return;
    fillChoices(groupSelect, groups, groupPreference, previousGroup);
    fillChoices(tagSelect, tags, tagPreference, previousTag);
    catalogReady = true;
    updateCatalogStatus();
  } catch (error) {
    if (activeCatalogCheck === check) {
      catalogResult.textContent =
        error instanceof BitBrowserCatalogError ? error.message : '比特连接检查未完成，请重试。';
    }
  } finally {
    if (activeCatalogCheck === check) {
      activeCatalogCheck = undefined;
      updateStartButton();
    }
  }
});

function clearConnectionSecrets() {
  tokenInput.value = '';
  tokenInput.type = 'password';
  get('bit-token-eye').setAttribute('aria-pressed', 'false');
  get('bit-token-eye').setAttribute('aria-label', '查看本机接口密钥');
  get('bit-proxy-url').value = '';
  clearProxyCredentials();
}

function clearProxyCredentials() {
  proxyUserInput.value = '';
  proxyPasswordInput.value = '';
  loadedProxyEndpoint = '';
}

function proxyEndpoint({ proxyMode, proxyType, staticHost, staticPort }) {
  return proxyMode === 'static' ? JSON.stringify([proxyType, staticHost, staticPort]) : '';
}

function formProxyEndpoint() {
  return proxyEndpoint({
    proxyMode: proxyMode.value,
    proxyType: profileControls.proxyType.value,
    staticHost: profileControls.staticHost.value.trim(),
    staticPort: profileControls.staticPort.valueAsNumber
  });
}

loginForm.addEventListener('input', () => {
  if (loadedProxyEndpoint && formProxyEndpoint() !== loadedProxyEndpoint) clearProxyCredentials();
});

function cancelConnectionRestore() {
  connectionRestoreId++;
  connectionRestoreController?.abort();
  connectionRestoreController = undefined;
  profileBusy = false;
}

function selectConnection(profile = defaultConnection) {
  cancelConnectionRestore();
  selectedProfileId = profile.id || '';
  profileChoice.value = selectedProfileId;
  defaultProfileResult.hidden = true;
  profileName.value = profile.name;
  accountName.value = profile.accountName || '';
  settings.open = !profile.id;
  urlInput.value = profile.url;
  groupPreference = profile.groupName;
  tagPreference = profile.tagName;
  for (const [key, control] of Object.entries(profileControls)) control.value = profile[key];
  restoreConnectionDraft();
  proxyMode.dispatchEvent(new Event('change'));
  clearConnectionSecrets();
  clearCatalog();
  profileResult.textContent = selectedProfileId ? '请填写这台电脑的接口密钥，再检测连接。' : '';
}

async function restoreConnection(profile) {
  selectConnection(profile);
  if (!moduleVisible || (!profile?.hasInterfaceToken && !profile?.hasStaticProxyCredentials)) return;
  const restoreId = ++connectionRestoreId;
  const controller = new AbortController();
  connectionRestoreController = controller;
  const active = () => restoreId === connectionRestoreId && moduleVisible && selectedProfileId === profile.id;
  profileBusy = true;
  updateStartButton();
  profileResult.textContent = '正在载入已保存的连接凭据…';
  try {
    const response = await fetch('/api/local/bitbrowser-connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ id: profile.id, version: profileData.version }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
    });
    const result = await response.json();
    if (!active()) return;
    if (!response.ok) {
      if (response.status === 409) {
        profileConflict = true;
        reloadProfileButton.hidden = false;
      }
      throw new Error();
    }
    if (urlInput.value === profile.url && !tokenInput.value && typeof result.interfaceToken === 'string') {
      tokenInput.type = 'password';
      tokenInput.value = result.interfaceToken;
    }
    const endpoint = proxyEndpoint(profile);
    if (result.staticProxyCredentials && endpoint && formProxyEndpoint() === endpoint &&
        !proxyUserInput.value && !proxyPasswordInput.value) {
      proxyUserInput.value = result.staticProxyCredentials.username;
      proxyPasswordInput.value = result.staticProxyCredentials.password;
      loadedProxyEndpoint = endpoint;
    }
    profileResult.textContent = '已载入保存的连接凭据。';
  } catch {
    if (active()) profileResult.textContent = '无法载入连接凭据，请重新读取配置或手动填写。';
  } finally {
    if (active()) {
      connectionRestoreController = undefined;
      profileBusy = false;
      updateStartButton();
    }
  }
  if (active() && tokenInput.value) catalogButton.click();
}

function updateProfileOptions() {
  profileChoice.replaceChildren(
    new Option('本次手动设置', ''),
    ...profileData.profiles.map(({ name, accountName, id }) => new Option(
      `${accountName || '账号待确认'} · ${name}${id === profileData.defaultId ? '（我的默认）' : ''}`, id
    ))
  );
  profileChoice.value = selectedProfileId;
}

async function profileRequest(payload, method = 'PUT') {
  const response = await fetch(
    '/api/local/bitbrowser-connections',
    payload
      ? {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }
      : { cache: 'no-store' }
  );
  const result = await response.json().catch(() => null);
  if (!response.ok || (method === 'PATCH'
    ? result?.defaultId !== payload.defaultId
    : !Array.isArray(result?.profiles))) {
    const error = new Error(result?.error || '无法读取或保存连接，请稍后重试。');
    error.status = response.status;
    throw error;
  }
  if (method === 'PATCH') return result;
  return { ...result, canSaveToken: response.headers.get('X-ID-BitBrowser-Token-Storage') === 'enabled' };
}

async function loadProfiles() {
  if (profileBusy || savingProfileDefault || activeLogin) return;
  profileBusy = true;
  reloadProfileButton.hidden = true;
  updateStartButton();
  let restore;
  try {
    const firstLoad = !profileData;
    profileData = await profileRequest();
    const selected = profileData.profiles.find(({ id }) => id === selectedProfileId);
    updateProfileOptions();
    if (profileConflict) {
      const values = readConnectionDrafts();
      if (Object.keys(values).some(key => key.startsWith(draftPrefix()))) {
        values[draftPrefix() + 'version'] = String(profileData.version);
        draftBridge?.write('bit-local', values);
      }
      selectConnection(selected);
      profileResult.textContent = '已读取最新配置，请核对后重新检测和保存。';
      restore = selected;
    }
    if (firstLoad) restore = profileData.profiles.find(({ id }) => id === profileData.defaultId);
    else if (selectedProfileId && !selected) selectConnection();
    profileConflict = false;
  } catch (error) {
    profileResult.textContent = error.message;
    reloadProfileButton.hidden = false;
  } finally {
    profileBusy = false;
    updateStartButton();
  }
  if (restore) await restoreConnection(restore);
}

async function saveProfileDefault() {
  if (defaultProfileButton.disabled) return;
  const defaultId = selectedProfileId === profileData.defaultId ? null : selectedProfileId;
  savingProfileDefault = true;
  updateStartButton();
  defaultProfileResult.hidden = false;
  defaultProfileResult.textContent = '正在保存个人默认比特账号…';
  try {
    const result = await profileRequest({ defaultId }, 'PATCH');
    profileData.defaultId = result.defaultId;
    updateProfileOptions();
    defaultProfileResult.textContent = defaultId ? '已设为我的默认比特账号。' : '已取消默认比特账号。';
  } catch (error) {
    defaultProfileResult.textContent = error.message;
  } finally {
    savingProfileDefault = false;
    updateStartButton();
  }
}

async function saveProfile() {
  if (saveProfileButton.disabled) return;
  if (!profileName.value.trim()) {
    profileResult.textContent = '请输入连接配置名称。';
    profileName.focus();
    return;
  }
  const fixedProxy = proxyMode.value === 'static';
  const username = proxyUserInput.value;
  const password = proxyPasswordInput.value;
  if (fixedProxy && Boolean(username) !== Boolean(password)) {
    profileResult.textContent = '请同时填写固定代理账号和密码。';
    (username ? proxyPasswordInput : proxyUserInput).focus();
    return;
  }
  const staticProxyCredentials = fixedProxy && username && password
    ? { username, password }
    : loadedProxyEndpoint ? null : undefined;
  const submittedPrefix = draftPrefix();
  const submittedDraft = readConnectionDrafts();
  const draftVersion = submittedDraft[submittedPrefix + 'version'];
  const profile = {
    ...(selectedProfileId && { id: selectedProfileId }),
    name: profileName.value.trim(),
    accountName: accountName.value.trim(),
    url: urlInput.value,
    groupName: groupSelect.selectedOptions[0].text,
    tagName: tagSelect.selectedOptions[0].text,
    coreVersion: profileControls.coreVersion.value,
    proxyMode: proxyMode.value,
    proxyType: profileControls.proxyType.value,
    expectedCountryCode: profileControls.expectedCountryCode.value.trim().toUpperCase(),
    staticHost: fixedProxy ? profileControls.staticHost.value.trim() : '',
    staticPort: fixedProxy
      ? profileControls.staticPort.valueAsNumber
      : defaultConnection.staticPort,
    sessionWaitMinutes: profileControls.sessionWaitMinutes.valueAsNumber,
    sessionRetryLimit: profileControls.sessionRetryLimit.valueAsNumber
  };
  profileBusy = true;
  updateStartButton();
  profileResult.textContent = '正在保存连接…';
  try {
    const interfaceToken = profileData.canSaveToken ? tokenInput.value.trim() : '';
    profileData = await profileRequest({
      version: /^\d+$/.test(draftVersion || '') ? Number(draftVersion) : profileData.version, profile,
      ...(interfaceToken && { interfaceToken }),
      ...(profileData.canSaveToken && staticProxyCredentials !== undefined && { staticProxyCredentials })
    });
    const latestDraft = readConnectionDrafts();
    const nextPrefix = `profile/${profileData.savedId}/`;
    for (const [key, value] of Object.entries(submittedDraft)) {
      if (!key.startsWith(submittedPrefix)) continue;
      if (latestDraft[key] === value) delete latestDraft[key];
    }
    // A successful late response clears only submitted values, preserving later edits.
    for (const [key, value] of Object.entries(latestDraft)) {
      if (!key.startsWith(submittedPrefix)) continue;
      if (key !== submittedPrefix + 'version') latestDraft[nextPrefix + key.slice(submittedPrefix.length)] = value;
      if (submittedPrefix !== nextPrefix) delete latestDraft[key];
    }
    if (Object.keys(latestDraft).some(key => key.startsWith(nextPrefix)))
      latestDraft[nextPrefix + 'version'] = String(profileData.version);
    draftBridge?.write('bit-local', latestDraft);
    selectedProfileId = profileData.savedId;
    if (staticProxyCredentials && formProxyEndpoint() === proxyEndpoint(profile))
      loadedProxyEndpoint = proxyEndpoint(profile);
    else if (staticProxyCredentials === null) loadedProxyEndpoint = '';
    updateProfileOptions();
    profileResult.textContent = '连接配置已保存。';
  } catch (error) {
    profileResult.textContent = error.message;
    if (error.status === 409) {
      profileConflict = true;
      reloadProfileButton.hidden = false;
    }
  } finally {
    profileBusy = false;
    updateStartButton();
  }
}

const toggleSettings = get('bit-toggle-connection');
toggleSettings.addEventListener('click', () => {
  settings.open = !settings.open;
  if (settings.open) settings.querySelector('summary').focus();
});
settings.addEventListener('toggle', () => {
  toggleSettings.setAttribute('aria-expanded', String(settings.open));
});
selectConnection();
if (profilesEnabled) {
  for (const control of document.querySelectorAll('[data-bit-profile]')) control.hidden = false;
  addProfileButton.addEventListener('click', () => {
    selectConnection();
    settings.open = true;
    profileName.focus();
  });
  profileChoice.addEventListener('change', () =>
    void restoreConnection(profileData.profiles.find(({ id }) => id === profileChoice.value))
  );
  saveProfileButton.addEventListener('click', () => void saveProfile());
  defaultProfileButton.addEventListener('click', () => void saveProfileDefault());
  reloadProfileButton.addEventListener('click', () => void loadProfiles());
  void loadProfiles();
}

const stageLabels = {
  bitbrowser_group: '正在读取比特窗口分组与标签…',
  owned_profile_check: '正在核对该账号的原窗口…',
  bitbrowser_profile_created: '窗口已创建，正在打开…',
  bitbrowser_profile_opened: '比特窗口已打开。',
  browser_control_connect: '正在连接比特窗口…',
  session_restore: '正在核验账号登录状态…',
  proxy_retrying: '比特窗口网络暂不可用，正在按原流程重试…',
  verification_required: '请在已打开的比特窗口完成验证。'
};

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (activeLogin || startButton.disabled) return;
  const check = new AbortController();
  activeLogin = check;
  setLoginLock(true);
  updateStartButton();
  const sessionJson = credential;
  // Keep the full email in the form and respect the login adapter's window name limit.
  const accountWindowName = windowName.value.slice(0, 100);
  loginFields.disabled = true;
  cancelButton.hidden = false;
  loginResult.textContent = '正在启动登录…';
  let executionProxy;
  try {
    executionProxy = await executionProxies.settings(check.signal);
    const { email, profileSequence } = await runBitBrowserJsonLogin({
      url: urlInput.value,
      token: tokenInput.value,
      groupName: groupSelect.selectedOptions[0].text,
      tagName: tagSelect.selectedOptions[0].text,
      windowName: accountWindowName,
      sessionJson,
      browserOptions: {
        coreVersion: get('bit-core').value,
        sessionWaitMinutes: profileControls.sessionWaitMinutes.valueAsNumber,
        sessionRetryLimit: profileControls.sessionRetryLimit.valueAsNumber,
        ...executionProxy.browserOptions
      },
      proxyType: executionProxy.proxyType,
      expectedCountryCode: executionProxy.expectedCountryCode,
      useSelectedProxy: true,
      persistWindow: profilesEnabled,
      connectionId: selectedProfileId,
      dynamicProxyUrl: executionProxy.dynamicProxyUrl,
      staticProxyCredentials: executionProxy.staticProxyCredentials,
      signal: check.signal,
      onProgress(stage) {
        if (!check.signal.aborted && Object.hasOwn(stageLabels, stage)) {
          loginResult.textContent = stageLabels[stage];
        }
      }
    });
    loginResult.textContent = Number.isSafeInteger(profileSequence) && profileSequence > 0
      ? `登录成功 · ${email}。比特窗口 #${profileSequence} 已保留。`
      : `登录成功 · ${email}。比特浏览器窗口已保留。`;
  } catch (error) {
    loginResult.textContent = check.signal.aborted
      ? '已停止登录操作。已打开的比特窗口可手动检查。'
      : error instanceof BitBrowserLoginError
        ? error.message
        : '登录未完成。请检查本机连接和窗口配置，重新导入授权后再试。';
  } finally {
    if (executionProxy) { executionProxy.dynamicProxyUrl = ''; if (executionProxy.staticProxyCredentials) { executionProxy.staticProxyCredentials.username = ''; executionProxy.staticProxyCredentials.password = ''; } }
    activeLogin = undefined;
    setLoginLock(false);
    loginFields.disabled = false;
    cancelButton.hidden = true;
    cancelButton.disabled = false;
    updateStartButton();
  }
});

cancelButton.addEventListener('click', () => {
  activeLogin?.abort();
  cancelButton.disabled = true;
  loginResult.textContent = '正在停止登录操作…';
});

window.addEventListener('pagehide', () => {
  moduleVisible = false;
  cancelConnectionRestore();
  authorizationCheckId++;
  activeLogin?.abort();
  clearCatalog();
  jsonInput.value = '';
  loadAuthorization('');
  clearConnectionSecrets();
});

function resumeConnection() {
  if (activeLogin || profileBusy || savingProfileDefault || !moduleVisible) return;
  const profile = profileData?.profiles.find(({ id }) => id === selectedProfileId);
  if (!tokenInput.value && profile?.hasInterfaceToken) void restoreConnection(profile);
  else if (tokenInput.value && !catalogReady) catalogButton.click();
}
window.addEventListener('pageshow', event => {
  if (event.persisted) { moduleVisible = true; resumeConnection(); }
});
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== window.parent || event.data?.source !== 'id-recharge-shell') return;
  if (event.data.type === 'data-change') {
    for (const scope of event.data.scopes || [])
      if (['bitbrowser-connections', 'bitbrowser-proxies'].includes(scope)) pendingDataChanges.add(scope);
    void refreshLiveChoices();
  }
  if (event.data.type === 'visibility' && typeof event.data.visible === 'boolean' && !activeLogin) {
    moduleVisible = event.data.visible;
    if (moduleVisible) void refreshLiveChoices().then(resumeConnection, resumeConnection);
    else {
      cancelConnectionRestore();
      clearCatalog();
      authorizationCheckId++;
      loadAuthorization('');
      clearConnectionSecrets();
    }
  } else if (event.data.type === 'theme' && ['light', 'dark'].includes(event.data.theme)) {
    document.documentElement.dataset.theme = event.data.theme;
  }
});
document.addEventListener('close', () => void refreshLiveChoices(), true);
get('bit-toggle-connection').addEventListener('click', () => queueMicrotask(refreshLiveChoices));
window.addEventListener('focus', () => void refreshLiveChoices());

if (jsonInput.value) loadAuthorization(jsonInput.value);

window.IDPagination?.watchTableLayout?.(document.body, { hostFrame: window.frameElement });

if (window.parent !== window) {
  document.body.classList.add('bit-local--embedded');
  const syncWorkspaceSpacing = () => {
    try {
      const hostStyle = window.parent.getComputedStyle(window.parent.document.documentElement);
      for (const token of ['--panel-padding-inline', '--panel-padding-block']) {
        const value = hostStyle.getPropertyValue(token).trim();
        if (value && document.documentElement.style.getPropertyValue(token) !== value)
          document.documentElement.style.setProperty(token, value);
      }
    } catch { /* Standalone tokens also cover an inaccessible embedding host. */ }
  };
  syncWorkspaceSpacing();
  try {
    document.documentElement.dataset.theme = window.parent.document.documentElement.dataset.theme || 'light';
    window.parent.addEventListener('resize', syncWorkspaceSpacing);
    window.addEventListener('pagehide', () => window.parent.removeEventListener('resize', syncWorkspaceSpacing), { once: true });
  } catch { /* Standalone styling remains the default for an inaccessible parent. */ }
  const reportHeight = () =>
    window.parent.postMessage(
      { source: 'id-bitbrowser-local', type: 'resize', height: document.body.getBoundingClientRect().height },
      location.origin
    );
  new ResizeObserver(reportHeight).observe(document.body);
  reportHeight();
}
