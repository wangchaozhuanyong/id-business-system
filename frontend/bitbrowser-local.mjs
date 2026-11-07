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
const lastConnectionKey = 'id-bitbrowser-last-connection';

let credential = '';
let lastAutomaticName = '';
let authorizationCheckId = 0;
let activeCatalogCheck;
let activeLogin;
document.documentElement.dataset.rechargeNavigationLocked = 'false';
function setLoginLock(locked) {
  document.documentElement.dataset.rechargeNavigationLocked = String(locked);
}
let catalogReady = false;
let profileData;
let profileBusy = false;
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
  if (Object.hasOwn(values, 'bit-window-name')) windowName.value = values['bit-window-name'];
}
function captureConnectionDraft(event) {
  if (!draftBridge || !event.isTrusted) return;
  const control = event.target;
  const values = readConnectionDrafts();
  const prefix = draftPrefix();
  if (control === windowName) values['bit-window-name'] = control.value;
  else if (connectionDraftFields.includes(control)) values[prefix + control.id] = control.value;
  else if (control === groupSelect && control.value) values[prefix + 'groupPreference'] = control.selectedOptions[0].text;
  else if (control === tagSelect && control.value) values[prefix + 'tagPreference'] = control.selectedOptions[0].text;
  else return;
  if (control !== windowName && profileData && !Object.hasOwn(values, prefix + 'version'))
    values[prefix + 'version'] = String(profileData.version);
  draftBridge.write('bit-local', values);
}
loginForm.addEventListener('input', captureConnectionDraft);
loginForm.addEventListener('change', captureConnectionDraft);

function updateStartButton() {
  startButton.disabled =
    !executionProxies?.ready() ||
    !credential ||
    !windowName.value.trim() ||
    !groupSelect.value ||
    !tagSelect.value ||
    !tokenInput.value ||
    Boolean(activeLogin || activeCatalogCheck || profileBusy);
  catalogButton.disabled = Boolean(activeLogin || activeCatalogCheck || profileBusy);
  saveProfileButton.disabled =
    !profileData ||
    profileBusy ||
    profileConflict ||
    !catalogReady ||
    !groupSelect.value ||
    !tagSelect.value ||
    Boolean(activeLogin);
  addProfileButton.disabled = !profileData || profileBusy || Boolean(activeLogin);
  profileChoice.disabled = !profileData || profileBusy || Boolean(activeLogin);
  get('bit-toggle-connection').disabled = Boolean(activeLogin);
  for (const id of ['bit-tab-login', 'bit-tab-library', 'bit-show-library']) get(id).disabled = Boolean(activeLogin);
}

function showWorkspace(view, focus = false) {
  if (activeLogin) return;
  for (const name of ['login', 'library']) {
    const selected = view === name, button = get('bit-tab-' + name);
    button.setAttribute('aria-selected', String(selected)); button.classList.toggle('active', selected); button.tabIndex = selected ? 0 : -1;
    get('bit-' + name + '-panel').hidden = !selected;
    if (selected && focus) button.focus();
  }
  const values = readConnectionDrafts(); values.workspace = view; draftBridge?.write('bit-local', values);
}
for (const name of ['login', 'library']) {
  get('bit-tab-' + name).addEventListener('click', () => showWorkspace(name));
  get('bit-tab-' + name).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); showWorkspace(event.key === 'Home' ? 'login' : event.key === 'End' ? 'library' : name === 'login' ? 'library' : 'login', true); }
  });
}
get('bit-show-library').addEventListener('click', () => showWorkspace('library', true));
showWorkspace(readConnectionDrafts().workspace === 'library' ? 'library' : 'login');
executionProxies = initializeExecutionProxies({ get, drafts: draftBridge, onChange: updateStartButton, locked: () => Boolean(activeLogin), onUse: () => showWorkspace('login') });
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
  jsonInput.placeholder = '粘贴完整授权 JSON，将自动载入';
  authorizationResult.textContent = '';
  if (value) {
    try {
      const { email } = parseBitBrowserAuthorization(value);
      credential = value;
      jsonInput.value = '';
      jsonInput.placeholder = '授权已自动载入，可粘贴新 JSON 替换';
      authorizationResult.textContent = `授权已载入 · ${email}`;
      const currentName = windowName.value;
      if (!currentName.trim() || currentName === lastAutomaticName) {
        lastAutomaticName = `ChatGPT-${email.split('@')[0]}`.slice(0, 80);
        windowName.value = lastAutomaticName;
      }
    } catch {
      authorizationResult.textContent = '请粘贴完整有效的单账户授权 JSON（不超过 65 KB）。';
    }
  }
  updateStartButton();
}

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
  tokenInput.value = '';
  clearCatalog();
});
tokenInput.addEventListener('input', clearCatalog);
windowName.addEventListener('input', updateStartButton);
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

function selectConnection(profile = defaultConnection) {
  selectedProfileId = profile.id || '';
  profileChoice.value = selectedProfileId;
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

function rememberConnection() {
  try {
    sessionStorage.setItem(lastConnectionKey, selectedProfileId);
  } catch {
    // Browser privacy settings can disable session storage.
  }
}

function lastConnection() {
  try {
    return sessionStorage.getItem(lastConnectionKey);
  } catch {
    return null;
  }
}

async function restoreConnection(profile) {
  selectConnection(profile);
  rememberConnection();
  if (!profile?.hasInterfaceToken && !profile?.hasStaticProxyCredentials) return;
  profileBusy = true;
  updateStartButton();
  profileResult.textContent = '正在载入已保存的连接凭据…';
  try {
    const response = await fetch('/api/local/bitbrowser-connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ id: profile.id, version: profileData.version })
    });
    const result = await response.json();
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
    profileResult.textContent = '无法载入连接凭据，请重新读取配置或手动填写。';
  } finally {
    profileBusy = false;
    updateStartButton();
  }
  if (tokenInput.value) catalogButton.click();
}

function updateProfileOptions() {
  profileChoice.replaceChildren(
    new Option('本次手动设置', ''),
    ...profileData.profiles.map(({ name, accountName, id }) => new Option(`${accountName || '账号待确认'} · ${name}`, id))
  );
  profileChoice.value = selectedProfileId;
}

async function profileRequest(payload) {
  const response = await fetch(
    '/api/local/bitbrowser-connections',
    payload
      ? {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }
      : { cache: 'no-store' }
  );
  const result = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(result?.profiles)) {
    const error = new Error(result?.error || '无法读取或保存连接，请稍后重试。');
    error.status = response.status;
    throw error;
  }
  return { ...result, canSaveToken: response.headers.get('X-ID-BitBrowser-Token-Storage') === 'enabled' };
}

async function loadProfiles() {
  if (profileBusy || activeLogin) return;
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
    if (firstLoad || !selectedProfileId) {
      restore = profileData.profiles.find(({ id }) => id === lastConnection());
    }
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
    rememberConnection();
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
    rememberConnection();
    settings.open = true;
    profileName.focus();
  });
  profileChoice.addEventListener('change', () =>
    void restoreConnection(profileData.profiles.find(({ id }) => id === profileChoice.value))
  );
  saveProfileButton.addEventListener('click', () => void saveProfile());
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
  if (startButton.disabled) return;
  const check = new AbortController();
  activeLogin = check;
  setLoginLock(true);
  const sessionJson = credential;
  loadAuthorization('');
  loginFields.disabled = true;
  cancelButton.hidden = false;
  loginResult.textContent = '正在启动登录…';
  let executionProxy;
  try {
    executionProxy = await executionProxies.settings(check.signal);
    const { email } = await runBitBrowserJsonLogin({
      url: urlInput.value,
      token: tokenInput.value,
      groupName: groupSelect.selectedOptions[0].text,
      tagName: tagSelect.selectedOptions[0].text,
      windowName: windowName.value.trim(),
      sessionJson,
      browserOptions: {
        coreVersion: get('bit-core').value,
        sessionWaitMinutes: profileControls.sessionWaitMinutes.valueAsNumber,
        sessionRetryLimit: profileControls.sessionRetryLimit.valueAsNumber,
        ...executionProxy.browserOptions
      },
      proxyType: executionProxy.proxyType,
      expectedCountryCode: executionProxy.expectedCountryCode,
      dynamicProxyUrl: executionProxy.dynamicProxyUrl,
      staticProxyCredentials: executionProxy.staticProxyCredentials,
      signal: check.signal,
      onProgress(stage) {
        if (!check.signal.aborted && Object.hasOwn(stageLabels, stage)) {
          loginResult.textContent = stageLabels[stage];
        }
      }
    });
    loginResult.textContent = `登录成功 · ${email}。比特浏览器窗口已保留。`;
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
  authorizationCheckId++;
  activeLogin?.abort();
  clearCatalog();
  credential = '';
  jsonInput.value = '';
  clearConnectionSecrets();
});

window.addEventListener('message', (event) => {
  if (
    event.origin === location.origin &&
    event.source === window.parent &&
    event.data?.source === 'id-recharge-shell' &&
    event.data.type === 'visibility' && event.data.visible === false && !activeLogin
  ) {
    authorizationCheckId++;
    loadAuthorization('');
    clearConnectionSecrets();
  } else if (
    event.origin === location.origin && event.source === window.parent &&
    event.data?.source === 'id-recharge-shell' &&
    event.data.type === 'theme' &&
    ['light', 'dark'].includes(event.data.theme)
  ) {
    document.documentElement.dataset.theme = event.data.theme;
  }
});

if (window.parent !== window) {
  try {
    document.documentElement.dataset.theme = window.parent.document.documentElement.dataset.theme || 'light';
  } catch { /* Standalone styling remains the default for an inaccessible parent. */ }
  const reportHeight = () =>
    window.parent.postMessage(
      { source: 'id-bitbrowser-local', type: 'resize', height: document.body.getBoundingClientRect().height },
      location.origin
    );
  new ResizeObserver(reportHeight).observe(document.body);
  reportHeight();
}
