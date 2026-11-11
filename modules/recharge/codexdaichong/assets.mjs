import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { CODEXDAICHONG_REVISION } from './prepare.mjs';
import { workspaceGuide, workspaceIcon } from './workspace-guide.mjs';
import { normalizeRechargeProxyInput } from './proxy-input.mjs';
import { RECHARGE_STAGE_LABELS, RECHARGE_STEP_LABELS } from './progress-presentation.mjs';
import { routingAdminPanel } from './routing-admin-ui.mjs';
import { createRechargeCardTypeOverlay } from './card-type-overlay.mjs';

const git = promisify(execFile);
const clone = fileURLToPath(new URL('../../../.upstream/codexdaichong/', import.meta.url));
const prefix = '/integrations/codexdaichong';
const media = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8'
};
const bundledPaths = {
  '/redeem': 'html', '/workspace': 'html', '/admin': 'html', '/subscription': 'html',
  '/admin.js': 'js', '/admin.css': 'css', '/style.css': 'css', '/favicon.svg': 'svg',
  '/lucide.js': 'js', '/shell.js': 'js', '/shell.css': 'css'
};

async function original(name) {
  const { stdout } = await git(
    'git',
    ['-C', clone, 'show', CODEXDAICHONG_REVISION + ':public/' + name],
    {
      encoding: 'utf8'
    }
  );
  return stdout;
}

function replaceOne(source, anchor, replacement) {
  const offset = source.indexOf(anchor);
  if (offset < 0 || source.indexOf(anchor, offset + anchor.length) >= 0) {
    throw new Error('上游源码与已核对版本不符');
  }
  return source.slice(0, offset) + replacement + source.slice(offset + anchor.length);
}

function replaceSection(source, start, end, replacement) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  if (first < 0 || last < 0) throw new Error('上游界面缺少已核对的适配边界');
  return source.slice(0, first) + replacement + '\n        ' + source.slice(last);
}

function localUrls(source) {
  return source
    .replace(/(['"`])\/api\//g, '$1' + prefix + '/api/')
    .replaceAll(
      '${protocol}//${window.location.host}`',
      '${protocol}//${window.location.host}' + prefix + '/socket`'
    );
}

function adaptAdminPagination(source) {
  source = replaceSection(source, '        const paginationState = {', '        const RUNTIME_LOG_TEXT_CAP',
    `        const paginationState = Object.fromEntries([
            'phone_pool', 'card_pool', 'cdk', 'product', 'log', 'session', 'proxy_pool',
            'address', 'manual_hold', 'admin_login', 'ip_ban'
        ].map(key => [key, { page: 1, pageSize: window.IDPagination.defaultPageSize }]));`);
  source = replaceSection(source, '        function changePage(', '        function getItemKey(', `
        const adminPageSizes = window.IDPagination.pageSizes;
        const paginationMarkup = new WeakMap();
        const adminLoadedRows = { admin_login: [], ip_ban: [] };
        function changePage(stateKey, nextPage) {
            if (stateKey === 'session') return loadSessions(false, { page: nextPage });
            paginationState[stateKey].page = nextPage;
            if (stateKey === 'phone_pool') renderPhoneTable();
            if (stateKey === 'card_pool') renderCardPoolTable();
            if (stateKey === 'cdk') renderCDKTable();
            if (stateKey === 'log') renderLogTable(window.__adminLogs || []);
            if (stateKey === 'product') renderProductTable();
            if (stateKey === 'proxy_pool') renderProxyPoolTable();
            if (stateKey === 'address') renderAddressTable();
            if (stateKey === 'manual_hold') renderActivationManualHolds();
            if (stateKey === 'admin_login') renderAdminLoginRows();
            if (stateKey === 'ip_ban') renderIpBanRows();
        }
        document.addEventListener('id-pagination-change', event => {
            const { id, page, pageSize } = event.detail || {};
            if (typeof id !== 'string' || !id.startsWith('recharge-') ||
                !Number.isSafeInteger(page) || page < 1 || !adminPageSizes.includes(pageSize)) return;
            const stateKey = id.slice('recharge-'.length);
            if (stateKey === 'orbitcard' || stateKey === 'session') {
                // The current control describes the last confirmed response until the new one succeeds.
                const size = event.target.querySelector('[data-pagination-size]');
                if (size) size.value = event.target.dataset.pageSize;
                if (stateKey === 'orbitcard') return void loadOrbitcardUsage(false, false, page, { pageSize });
                return void loadSessions(false, { page, pageSize });
            }
            if (!Object.hasOwn(paginationState, stateKey)) return;
            paginationState[stateKey].pageSize = pageSize;
            changePage(stateKey, page);
        });
  `);
  source = replaceSection(source, '        function getPaginationItems(', '        function switchAdminSection(', `
        function renderSharedAdminPagination(container, stateKey, { page, pageSize, total }) {
            if (!container) return;
            const note = ['log', 'manual_hold', 'admin_login', 'ip_ban'].includes(stateKey)
                ? '<p class="recharge-pagination-note">仅统计本次已加载的最近记录。</p>' : '';
            const markup = note + window.IDPagination.render({
                id: 'recharge-' + stateKey, page, pageSize, total, pageSizes: adminPageSizes
            });
            // Three-second refreshes must not clear an in-progress jump or steal focus.
            if (paginationMarkup.get(container) === markup && container.firstElementChild) return;
            const previous = container.querySelector('[data-pagination]');
            const viewport = container.previousElementSibling;
            if (viewport?.matches('.table-container')) {
                viewport.dataset.paginationRows = '';
                viewport.tabIndex = 0;
                if (!viewport.hasAttribute('role')) viewport.setAttribute('role', 'region');
                if (!viewport.hasAttribute('aria-label')) viewport.setAttribute('aria-label', '数据表，可滚动');
                if (previous && (Number(previous.dataset.page) !== page || Number(previous.dataset.pageSize) !== pageSize))
                    viewport.scrollTop = 0;
            }
            container.classList.add('recharge-table-pagination');
            container.innerHTML = markup;
            paginationMarkup.set(container, markup);
        }
        function renderPagination(containerId, stateKey, total) {
            renderSharedAdminPagination(document.getElementById(containerId), stateKey, {
                ...paginationState[stateKey], total
            });
        }
        function paginateAdminRows(body, stateKey, rows) {
            const data = getPageItems(rows, stateKey);
            const id = 'recharge_' + stateKey + '_pagination';
            let container = document.getElementById(id);
            if (!container) {
                container = document.createElement('div');
                container.id = id;
                container.className = 'table-footer';
                body.closest('table').parentElement.after(container);
            }
            renderSharedAdminPagination(container, stateKey, data);
            return data.items;
        }
  `);
  for (const [collection, key] of [
    ['cardPoolList', 'card_pool'], ['proxyPoolList', 'proxy_pool'],
    ['regionAddressList', 'address'], ['activationManualHolds', 'manual_hold']
  ]) {
    const bodyStart = {
      card_pool: "            const tbody = document.getElementById('card_pool_list_body');",
      proxy_pool: "            const summary = document.getElementById('proxy_pool_summary');\n            if (!tbody) return;",
      address: "            const hint = document.getElementById('address_empty_hint');\n            if (!tbody) return;",
      manual_hold: "        function renderActivationManualHolds() {\n            const tbody = document.getElementById('activation_manual_hold_body');\n            if (!tbody) return;"
    }[key];
    source = replaceOne(source, bodyStart,
      `${bodyStart}\n            const pageRows = paginateAdminRows(tbody, '${key}', ${collection});`);
    source = replaceOne(source, `tbody.innerHTML = ${collection}.map(`, 'tbody.innerHTML = pageRows.map(');
  }
  for (const [collection, key, field, bodyId, renderer, anchor] of [
    ['logs', 'admin_login', 'logs', 'admin_login_logs_body', 'renderAdminLoginRows', 'async function loadIpBans()'],
    ['bans', 'ip_ban', 'bans', 'ip_ban_body', 'renderIpBanRows', 'async function submitIpBan()']
  ]) {
    const rowStart = `                const ${collection} = data.${field} || [];\n`;
    const start = source.indexOf(rowStart);
    const end = source.indexOf('            } catch (error) {', start);
    if (start < 0 || end < 0) throw new Error('上游后台列表适配点不一致');
    const originalRows = source.slice(start + rowStart.length, end);
    source = replaceOne(source, rowStart + originalRows,
      `                adminLoadedRows.${key} = Array.isArray(data.${field}) ? data.${field} : [];\n                ${renderer}();\n`);
    source = replaceOne(source, anchor, `function ${renderer}() {
            const body = document.getElementById('${bodyId}');
            if (!body) return;
            const ${collection} = paginateAdminRows(body, '${key}', adminLoadedRows.${key});
${originalRows}        }

        ${anchor}`);
  }
  return adaptRemoteAdminPagination(source);
}

function adaptRemoteAdminPagination(source) {
  source = replaceOne(source, `            paginationState.session.page = 1;
            loadSessions(false).catch(() => { });`,
    `            loadSessions(false, { page: 1 }).catch(() => { });`);
  source = replaceOne(source, '        async function loadSessions(showToast = false, options = {}) {',
    `        let sessionPageRequestId = 0;
        async function loadSessions(showToast = false, options = {}) {
            const requestId = ++sessionPageRequestId;`);
  source = replaceOne(source, `            state.page = page;
            const query = new URLSearchParams({
                limit: String(state.pageSize),
                offset: String((page - 1) * state.pageSize),`,
    `            const pageSize = options.pageSize ?? state.pageSize;
            const query = new URLSearchParams({
                limit: String(pageSize),
                offset: String((page - 1) * pageSize),`);
  source = replaceOne(source, `                const res = await authFetch(\`/api/admin/sessions?\${query.toString()}\`);
                const parsed = await readJsonResponse(res);
                if (!parsed.ok) {
                    throw new Error(parsed.message);
                }`,
    `                const res = await authFetch(\`/api/admin/sessions?\${query.toString()}\`);
                const parsed = await readJsonResponse(res);
                if (requestId !== sessionPageRequestId) return;
                if (!res.ok || !parsed.ok) throw new Error(parsed.message || '加载 Session 失败');`);
  source = replaceOne(source, `                sessionTotal = Math.max(0, Number(data.total) || nextList.length);
                const totalPages = Math.max(1, Math.ceil(sessionTotal / state.pageSize));
                if (state.page > totalPages) {
                    state.page = totalPages;
                    return loadSessions(showToast, { ...options, page: totalPages, search });
                }`,
    `                const total = Math.max(0, Number(data.total) || nextList.length);
                const totalPages = Math.max(1, Math.ceil(total / pageSize));
                if (page > totalPages) {
                    return loadSessions(showToast, { ...options, page: totalPages, pageSize, search });
                }
                state.page = page;
                state.pageSize = pageSize;
                sessionTotal = total;`);
  source = replaceOne(source, `                if (showToast) {
                    showMessage(error.message || '加载 Session 失败', 'error');`,
    `                if (requestId === sessionPageRequestId && (showToast || options.page != null)) {
                    showMessage(error.message || '加载 Session 失败', 'error');`);
  source = replaceOne(source, '        const orbitcardUsageState = {\n            page: 1,\n            pageSize: 20,',
    '        const orbitcardUsageState = {\n            page: 1,\n            pageSize: window.IDPagination.defaultPageSize,');
  source = replaceOne(source, 'page = orbitcardUsageState.page) {', 'page = orbitcardUsageState.page, options = {}) {');
  source = replaceOne(source, `            orbitcardUsageState.page = Math.max(1, Number(page) || 1);
            try {
                const params = new URLSearchParams({
                    page: String(orbitcardUsageState.page),
                    page_size: String(orbitcardUsageState.pageSize),`,
    `            const requestedPage = Math.max(1, Number(page) || 1);
            const pageSize = options.pageSize ?? orbitcardUsageState.pageSize;
            try {
                const params = new URLSearchParams({
                    page: String(requestedPage),
                    page_size: String(pageSize),`);
  source = replaceOne(source, '                orbitcardUsageState.page = Number(data.page || orbitcardUsageState.page);',
    '                orbitcardUsageState.page = Number(data.page || requestedPage);\n                orbitcardUsageState.pageSize = pageSize;');
  source = replaceOne(source, "                console.error('loadOrbitcardUsage failed', error);",
    `                console.error('loadOrbitcardUsage failed', error);
                if (options.pageSize != null) {
                    showMessage(error.message || '加载 Orbitcard 记录失败', 'error');
                    return;
                }`);
  return replaceSection(source, '        function renderOrbitcardUsagePagination(', '        function formatOrbitcardPlan(', `
        function renderOrbitcardUsagePagination() {
            renderSharedAdminPagination(document.getElementById('orbitcard_usage_pagination'), 'orbitcard', orbitcardUsageState);
        }
  `);
}

function adaptAdminScript(source, routingScript) {
  source = adaptAdminPagination(source);
  source = replaceSection(source, '        async function saveProxyPool() {', '        function applyProxyTestResultToRow', `
        const normalizeRechargeProxyInput = ${normalizeRechargeProxyInput.toString()};
        function normalizeProxyPoolEditor(input) {
            const batch = normalizeRechargeProxyInput(input.value);
            input.value = batch.proxies.join('\\n');
            const hint = document.getElementById('proxy_add_hint');
            if (hint) {
                hint.setAttribute('role', 'status');
                hint.textContent = '已识别 ' + batch.proxies.length + ' 条代理，已自动整理格式' +
                    (batch.duplicates ? '，去重 ' + batch.duplicates + ' 条' : '') + '，请点击保存。';
            }
            return batch;
        }
        function previewProxyPoolInput(input) {
            if (!input?.isConnected || !input.value.trim() || input.dataset.saving === 'true') return;
            try { normalizeProxyPoolEditor(input); }
            catch (error) {
                const hint = document.getElementById('proxy_add_hint');
                if (hint) { hint.setAttribute('role', 'alert'); hint.textContent = error.message; }
            }
        }
        document.addEventListener('paste', event => {
            const input = event.target;
            if (input?.id === 'proxy_add_input') setTimeout(() => previewProxyPoolInput(input), 0);
        });
        document.addEventListener('change', event => {
            if (event.target?.id === 'proxy_add_input') previewProxyPoolInput(event.target);
            if (event.target?.id === 'proxy_add_country') event.target.removeAttribute('aria-invalid');
        });
        function clearProxyPoolEditor() {
            document.getElementById('proxy_add_input').value = '';
            const country = document.getElementById('proxy_add_country');
            country.value = '';
            country.removeAttribute('aria-invalid');
            document.getElementById('proxy_add_hint').textContent = '';
        }
        async function saveProxyPool() {
            const input = document.getElementById('proxy_add_input');
            const country = document.getElementById('proxy_add_country');
            const hint = document.getElementById('proxy_add_hint');
            if (!input || input.dataset.saving === 'true') return;
            const countryCode = country?.value;
            if (!countryCode || country.disabled) {
                const message = country?.disabled ? '请先刷新代理列表，读取国家选项。' : '请选择代理国家。';
                if (hint) { hint.setAttribute('role', 'alert'); hint.textContent = message; }
                country?.setAttribute('aria-invalid', 'true');
                country?.focus();
                return;
            }
            let batch;
            try { batch = normalizeProxyPoolEditor(input); }
            catch (error) {
                if (hint) { hint.setAttribute('role', 'alert'); hint.textContent = error.message; }
                showMessage(error.message, 'warning');
                return;
            }
            const submitted = input.value;
            const button = document.querySelector('button[onclick="saveProxyPool()"]');
            input.dataset.saving = 'true';
            if (button) button.disabled = true;
            if (hint) { hint.setAttribute('role', 'status'); hint.textContent = '正在保存 ' + batch.proxies.length + ' 条代理…'; }
            try {
                const res = await authFetch('/api/admin/proxies', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ proxies: batch.proxies, countryCode })
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    if (hint) {
                        hint.setAttribute('role', 'alert');
                        hint.textContent = (data.message || '保存失败。') + ' 输入已保留。';
                    }
                    return;
                }
                if (input.value === submitted && country.value === countryCode) clearProxyPoolEditor();
                if (hint) hint.textContent = data.message || '代理已保存';
                showMessage(data.message || '代理已保存', 'success');
                await loadProxyPool().catch(() => {
                    if (hint) hint.textContent = '代理已保存，列表刷新失败，请点击刷新。';
                });
            } catch {
                if (hint) { hint.setAttribute('role', 'alert'); hint.textContent = '保存未完成，输入已保留，请刷新代理列表核对后重试。'; }
                showMessage('保存代理未完成，请核对列表后重试', 'error');
            } finally {
                delete input.dataset.saving;
                if (button?.isConnected) button.disabled = false;
            }
        }
  `);
  source = replaceSection(source, 'const TOKEN_KEY', 'const BUSINESS_PAGES', '');
  source = replaceOne(source,
    '<td id="proxy_ip_${item.id}">${ipCell}</td>',
    '<td id="proxy_country_${item.id}" class="proxy-country-cell"></td>\n' +
      '                        <td id="proxy_ip_${item.id}" class="proxy-exit-cell">${ipCell}</td>');
  source = replaceOne(source, 'colspan="7">暂无代理，请在上方粘贴 URL 后点击「保存到代理池」',
    'colspan="8">暂无代理，请选择国家并录入代理');
  source = replaceSection(source, 'function getAdminToken()', 'function formatDurationText(', '');
  source = replaceSection(
    source,
    'function redirectToLogin()',
    'async function loadAdminSecurityStatus()',
    `
        async function authFetch(url, options = {}) {
            const response = await fetch(url, { ...options, credentials: 'same-origin' });
            if (response.status === 401) {
                window.idRechargeReport('session-expired');
                throw new Error('统一登录已失效');
            }
            return response;
        }
  `
  );
  source = replaceSection(
    source,
    'async function ensureAdminSession()',
    'async function reloadSystemConfigFromServer()',
    `
        async function ensureAdminSession() {
            const response = await authFetch('/api/admin/session');
            if (!response.ok) throw new Error('无法核对充值权限');
            return response.json();
        }
  `
  );
  source = replaceSection(
    source,
    'async function bootAdmin()',
    "document.getElementById('maintenance_mode')?.addEventListener",
    `
        async function bootAdmin() {
            if (window.idRechargeTaskLog) {
                await openTaskLogModal(window.idRechargeTaskLog);
                return;
            }
            try {
                await ensureAdminSession();
                if (document.documentElement.hasAttribute('data-recharge-telegram')) {
                    const statusUrl = new URL('api/local/system-monitoring?tab=legacy', location.origin);
                    const status = await authFetch(statusUrl, { cache: 'no-store' });
                    if (!status.ok) throw new Error('无法核对代充通知状态');
                    if ((await status.json()).phase !== 'native') {
                        window.idRechargeReport('telegram-locked');
                        return;
                    }
                    await reloadSystemConfigFromServer();
                    lucide.createIcons();
                    window.idRechargeReport('ready');
                    return;
                }
                await loadData(true);
                await loadRegionConfig();
                await loadGptApiConfig();
                if (adminDataRefreshTimer) clearInterval(adminDataRefreshTimer);
                adminDataRefreshTimer = setInterval(() => {
                    if (!document.hidden && window.idRechargeVisible !== false && !adminDataRefreshPaused)
                        loadData(false).catch(() => { });
                }, 3000);
                updateAdminDataRefreshButton();
                lucide.createIcons();
                window.idRechargeSelect(new URLSearchParams(location.search).get('view'));
                window.idRechargeReport('ready');
            } catch (error) {
                console.error('Admin boot failed', error);
                window.idRechargeReport('unavailable');
            }
        }
  `
  );
  source = replaceOne(
    source,
    "                openTaskLogModal(viewTaskLogBtn.getAttribute('data-view-task-log') || '');",
    "                const jobKey = viewTaskLogBtn.dataset.viewTaskLog;\n" +
      '                if (!window.idRechargeOpenTaskLog(jobKey)) openTaskLogModal(jobKey);'
  );
  source = replaceOne(
    source,
    '        function formatTaskDetailLog(task, runtimeEntries) {',
    String.raw`        function formatTaskDetailLog(task, runtimeEntries) {
            const terminalFailure = ['failed', 'manual'].includes(String(task.status || '').toLowerCase());
            if (terminalFailure && /^[A-Za-z0-9_-]{1,128}$/.test(task.jobKey || '')) {
                const lastAttempt = String(task.rawOutput || '')
                    .split(/^===== ATTEMPT \d+(?: \| CARD \d{4})? =====\r?$/m).at(-1);
                const submit = /^\[Stripe\] ✅ 已点击提交按钮 \([^\r\n]+\)\r?$/m.exec(lastAttempt);
                const billingError = /^❌ \[运行时错误\]: MySQL 执行失败: Data too long for column ['"]error_message['"] at row \d+\r?$/mi.exec(lastAttempt);
                if (submit && billingError && submit.index < billingError.index) {
                    return '<p class="task-log-step-detail">任务编号：' + escapeHtml(task.jobKey) + '</p>' +
                        '<p class="task-log-step-title">已点击付款，失败记录保存异常；付款结果待核实</p>';
                }
            }`
  );
  source = replaceOne(source, '                loadAdminSecurityStatus().catch(() => { });', '');
  for (const call of ['fetchRuntimeLogsIncremental();', 'fetchCheckoutDebugLogsIncremental();', 'pollCheckoutDebugStatus(false);'])
    source = replaceOne(source, '                ' + call,
      '                if (!document.hidden && window.idRechargeVisible !== false) ' + call);
  source = replaceOne(source, 'uptimeTickTimer = setInterval(renderUptimeTick, 1000);',
    'uptimeTickTimer = setInterval(() => { if (!document.hidden && window.idRechargeVisible !== false) renderUptimeTick(); }, 1000);');
  // The host must keep the last working iframe when its replacement cannot load.
  source = replaceOne(
    source,
    "                const res = await authFetch('/api/admin/data');\n                const data = await res.json();\n                document.getElementById('stat_cpu_percent')",
    "                const res = await authFetch('/api/admin/data');\n                if (!res.ok) throw new Error('无法载入代充工作区');\n                const data = await res.json();\n                document.getElementById('stat_cpu_percent')"
  );
  source = replaceOne(
    source,
    "                console.error('Failed to load data', error);",
    "                if (isInitial) throw error;\n                console.error('Failed to load data', error);"
  );
  // Imported CDKs can contain quote characters. Keep them as data in the same-origin UI.
  for (const [anchor, replacement] of [
    [
      "                const status = typeof cdk === 'string' ? 'unused' : (cdk.status || 'unused');",
      "                const codeArg = escapeHtml(JSON.stringify(code));\n                const status = typeof cdk === 'string' ? 'unused' : (cdk.status || 'unused');"
    ],
    [
      "toggleSelection('cdk', '${code}', this.checked)",
      "toggleSelection('cdk', ${codeArg}, this.checked)"
    ],
    ["copyCDK('${code}')", 'copyCDK(${codeArg})'],
    ['<code>${code}</code>', '<code>${escapeHtml(code)}</code>'],
    ["deleteCDK('${code}')", 'deleteCDK(${codeArg})'],
    [
      "                    <td>${usedAt || '-'}</td>",
      "                    <td>${escapeHtml(usedAt || '-')}</td>"
    ]
  ])
    source = replaceOne(source, anchor, replacement);
  source = replaceOne(
    source,
    '        async function loadCardPoolList() {',
    '        async function loadCardPoolList() {\n' +
      "            if (document.getElementById('cards')?.classList.contains('active')) " +
      'void rechargeCardTypes.refresh();'
  );
  source = replaceOne(
    source,
    '                cardPoolList = Array.isArray(data.cards) ? data.cards : (Array.isArray(data) ? data : []);\n                renderCardPoolTable();',
    `                const rows = Array.isArray(data.cards) ? data.cards : (Array.isArray(data) ? data : null);
                if (!res.ok || !rows) throw new Error('卡池读取失败');
                cardPoolList = rows;
                renderCardPoolTable();
                return rows;`
  );
  source = replaceOne(
    source,
    "            const btn = document.getElementById('card_pool_import_btn');\n            const text = (textarea.value || '').trim();",
    `            const btn = document.getElementById('card_pool_import_btn');
            const typeId = document.getElementById('card_pool_import_type').value;
            if (btn.disabled || !typeId) return;
            const submitted = textarea.value;
            const text = submitted.trim();`
  );
  source = replaceOne(
    source,
    "            lucide.createIcons();\n\n            try {\n                const res = await authFetch('/api/admin/cards/import', {",
    `            lucide.createIcons();
            btn.dataset.saving = 'true';
            paintRechargeCardTypes();

            try {
                const res = await authFetch('/api/admin/cards/import', {`
  );
  source = replaceSection(
    source,
    '                if (res.ok) {\n                    const imported = data.imported || 0;',
    '        // ============ End Card Pool Management ============',
    `                if (!res.ok) throw new Error('卡池导入回执待核对');
                const numbers = rechargeCardTypes.acceptedNumbers(cards, data);
                if (textarea.value === submitted) textarea.value = '';
                const result = await finishRechargeCardImport(numbers, typeId);
                resultEl.textContent = '导入 ' + data.imported + ' 张，跳过重复 ' + data.skipped +
                    ' 张，失败 ' + (data.failed + parseErrors.length) + ' 张' + result;
                resultEl.style.color = 'var(--text-dim)';
            } catch {
                resultEl.textContent = '导入回执待核对，请先刷新卡池查看。';
                resultEl.style.color = 'var(--error)';
            } finally {
                delete btn.dataset.saving;
                btn.innerHTML = '<i data-lucide="check-check"></i> 解析并导入';
                paintRechargeCardTypes();
                lucide.createIcons();
            }
        }
`
  );
  source = replaceOne(
    source,
    '<tr><td colspan="10" style="text-align:center; color: var(--text-dim); padding: 40px 0;">暂无卡片，请使用批量导入添加</td></tr>',
    '<tr><td colspan="11" style="text-align:center; color: var(--text-dim); padding: 40px 0;">暂无卡片，请使用批量导入添加</td></tr>'
  );
  source = replaceOne(
    source,
    "const cardNumber = escapeHtml(card.card_number || card.last4 || '****');",
    "const cardKey = rechargeCardTypes.cardKey(card.id);\n" +
      "                const cardNumber = escapeHtml(card.card_number || card.last4 || '****');"
  );
  source = replaceOne(
    source,
    '<td><code>${cardNumber}</code></td>',
    '<td><code>${cardNumber}</code></td>\n' +
      '                    <td data-recharge-card-type="${cardKey}"></td>'
  );
  const deleteCardButton = '<button class="btn-delete" onclick="deleteCardPoolItem(${card.id})" title="删除">\n' +
    '                            <i data-lucide="trash-2"></i>\n                        </button>';
  source = replaceOne(
    source,
    deleteCardButton,
    '<div class="table-action-group">${renderRechargeCardTypeEdit(cardKey)}' + deleteCardButton + '</div>'
  );
  source = replaceOne(
    source,
    "            }).join('');\n            lucide.createIcons();\n        }\n\n        function getCardStatusBadge(card)",
    "            }).join('');\n            paintRechargeCardTypes();\n            lucide.createIcons();\n        }\n\n        function getCardStatusBadge(card)"
  );
  for (const [anchor, replacement] of [
    [
      '        function renderLogTable(logs) {',
      `        function renderRechargeCellText(value) {
            if (!value) return '-';
            const text = escapeHtml(value);
            return '<button type="button" class="recharge-cell-text" aria-haspopup="dialog" title="' + text + '">' + text + '</button>';
        }
        function renderLogTable(logs) {`
    ],
    ['infoParts.push(escapeHtml(l.message));', 'infoParts.push(renderRechargeCellText(l.message));'],
    [
      '<span style="color:var(--text-dim); font-size:12px;">阶段：${escapeHtml(l.automation.phase)}</span>',
      "<div class=\"recharge-cell-phase\">${renderRechargeCellText('阶段：' + l.automation.phase)}</div>"
    ],
    [
      '<span style="color:#047857; font-size:12px;">Checkout 已打开</span>',
      '<div class="recharge-cell-checkout">Checkout 已打开</div>'
    ],
    ["infoParts.join('<br>')", "infoParts.join('')"],
    [
      'data-label="任务信息">${escapeHtml(row.message || \'-\')}</td>',
      'data-label="任务信息">${renderRechargeCellText(row.message)}</td>'
    ],
    [
      '<td style="max-width:320px; white-space:normal;">${escapeHtml(hold.reason || \'-\')}</td>',
      '<td>${renderRechargeCellText(hold.reason)}</td>'
    ]
  ])
    source = replaceOne(source, anchor, replacement);
  // Add the local settings call after namespacing upstream URLs. It goes to the host, not the engine.
  return replaceOne(localUrls(source + '\n' + routingScript), '        let cardPoolList = [];', `
        let cardPoolList = [];
        function hasHostedCardTypeEditor() {
            return window.frameElement?.matches('.recharge-integration__frame[data-view="cards"][data-view-group="admin"]');
        }
        function renderRechargeCardTypeEdit(cardKey) {
            if (!cardKey || !hasHostedCardTypeEditor()) return '';
            return '<button type="button" class="btn btn-secondary" aria-haspopup="dialog" data-edit-recharge-card-type="' +
                cardKey + '">修改</button>';
        }
        document.getElementById('card_pool_list_body')?.addEventListener('click', (event) => {
            const trigger = event.target.closest('[data-edit-recharge-card-type]');
            if (!trigger || window.idRechargeVisible === false) return;
            window.parent.postMessage({ source: 'id-codexdaichong', type: 'edit-card-type',
                cardKey: trigger.dataset.editRechargeCardType }, location.origin);
        });
        const rechargeCardTypes = (${createRechargeCardTypeOverlay.toString()})({
            async fetchSettings() {
                const response = await fetch('/api/local/card-types', {
                    cache: 'no-store', signal: AbortSignal.timeout(5000)
                });
                if (!response.ok) throw new Error('无法读取银行卡类型');
                return response.json();
            },
            onChange: paintRechargeCardTypes
        });
        let pendingRechargeCardType;
        window.idRechargeCardTypesChanged = () => {
            if (!document.hidden && window.idRechargeVisible !== false &&
                document.getElementById('cards')?.classList.contains('active'))
                void rechargeCardTypes.invalidate();
        };
        function paintRechargeCardTypes() {
            const status = document.getElementById('card_pool_type_status');
            const retry = document.getElementById('card_pool_type_retry');
            if (status) status.textContent = rechargeCardTypes.status;
            if (retry) retry.hidden = !rechargeCardTypes.failed;
            const typeSelect = document.getElementById('card_pool_import_type');
            const importButton = document.getElementById('card_pool_import_btn');
            const busy = importButton.dataset.saving === 'true' || Boolean(pendingRechargeCardType);
            const unavailable = rechargeCardTypes.version === null || !rechargeCardTypes.options.length;
            fillRechargeCardTypeSelect(typeSelect, typeSelect.value,
                rechargeCardTypes.version !== null && !rechargeCardTypes.options.length
                    ? '暂无可用银行卡类型' : '请选择银行卡类型');
            typeSelect.disabled = unavailable || busy;
            importButton.disabled = typeSelect.disabled || !typeSelect.value;
            const hosted = hasHostedCardTypeEditor();
            for (const cell of document.querySelectorAll('#card_pool_list_body [data-recharge-card-type]')) {
                const cardId = cell.dataset.rechargeCardType;
                if (!cardId) { cell.textContent = '未设置'; continue; }
                if (hosted) { cell.textContent = rechargeCardTypes.label(cardId); continue; }
                let select = cell.querySelector('select');
                if (!select) {
                    select = document.createElement('select');
                    select.className = 'asset-input';
                    select.setAttribute('aria-label', '设置银行卡类型');
                    cell.replaceChildren(select);
                }
                const selected = pendingRechargeCardType?.cardId === cardId
                    ? pendingRechargeCardType.typeId : rechargeCardTypes.typeId(cardId);
                fillRechargeCardTypeSelect(select, selected, rechargeCardTypes.label(cardId));
                select.disabled = unavailable || busy;
            }
        }
        function fillRechargeCardTypeSelect(select, selected, placeholder) {
            const options = rechargeCardTypes.options.map(item => new Option(item.name, item.id));
            if (!options.some(option => option.value === selected)) {
                const empty = new Option(placeholder, '');
                empty.disabled = true;
                options.unshift(empty);
                selected = '';
            }
            select.replaceChildren(...options);
            select.value = selected;
        }
        async function writeRechargeCardType(command) {
            const version = rechargeCardTypes.version;
            if (version === null || !rechargeCardTypes.options.some(item => item.id === command.typeId))
                throw new Error('请选择可用的银行卡类型');
            const response = await fetch('/api/local/card-types', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...command, version })
            });
            if (!response.ok) throw new Error(response.status === 409
                ? '银行卡类型已更新，请刷新后重试' : '银行卡类型保存未确认，请刷新后核对');
            return response.json();
        }
        async function finishRechargeCardImport(numbers, typeId) {
            const cards = await loadCardPoolList();
            if (!numbers.size) return '';
            const pending = '；银行卡类型待核对，可在列表补设';
            if (!cards) return pending;
            const { cardIds, missing } = rechargeCardTypes.matchCardIds(numbers, cards);
            if (!cardIds.length) return pending;
            try {
                await rechargeCardTypes.refresh();
                const { importTypes } = await writeRechargeCardType({ action: 'assign-imported', cardIds, typeId });
                await rechargeCardTypes.refresh();
                return '；已确认银行卡类型 ' + (importTypes.assigned + importTypes.alreadyAssigned) + ' 张' +
                    (importTypes.conflict ? '，已有其他类型 ' + importTypes.conflict + ' 张' : '') +
                    (missing + importTypes.missing ? '，待核对 ' + (missing + importTypes.missing) + ' 张' : '');
            } catch {
                void rechargeCardTypes.refresh();
                return pending;
            }
        }
        document.getElementById('card_pool_import_type').addEventListener('change', paintRechargeCardTypes);
        document.getElementById('card_pool_list_body').addEventListener('change', async (event) => {
            const select = event.target;
            const cardId = select.closest('[data-recharge-card-type]')?.dataset.rechargeCardType;
            if (select.tagName !== 'SELECT' || !cardId || select.disabled || pendingRechargeCardType) return;
            const typeId = select.value;
            pendingRechargeCardType = { cardId, typeId };
            paintRechargeCardTypes();
            try {
                await writeRechargeCardType({ action: 'assign', cardId, typeId });
                showMessage('银行卡类型已保存', 'success');
            } catch (error) {
                showMessage(error.message, 'error');
            } finally {
                await rechargeCardTypes.refresh();
                pendingRechargeCardType = undefined;
                paintRechargeCardTypes();
            }
        });
        document.getElementById('card_pool_type_retry')?.addEventListener('click', () => {
            void rechargeCardTypes.refresh();
        });
  `);
}

function inlineHashes(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, script]) => {
    return "'sha256-" + createHash('sha256').update(script).digest('base64') + "'";
  });
}

function adaptRedeemHtml(source) {
  const replacements = [
    [
      'activationLocked = Boolean(locked);',
      'activationLocked = Boolean(locked);\n            window.idRechargeSetNavigationLock(activationLocked);'
    ],
    [
      'function showStatus(message, type) {',
      'function showStatus(message, type, queryMarkup = false) {'
    ],
    [
      'statusMsg.innerHTML = message;',
      'if (queryMarkup) statusMsg.innerHTML = message;\n            else statusMsg.textContent = message;'
    ],
    [
      "showStatus(resultHtml, isUsed ? 'error' : 'success');",
      "showStatus(resultHtml, isUsed ? 'error' : 'success', true);"
    ],
    ['<code>${cdk}</code>', '<code>${escapeHtml(cdk)}</code>'],
    ['<strong>${planLabel}</strong>', '<strong>${escapeHtml(planLabel)}</strong>'],
    [
      'class="status-${statusClass}">${statusText}',
      'class="status-${statusClass}">${escapeHtml(statusText)}'
    ],
    ["${data.data.usedAt || '-'}", "${escapeHtml(data.data.usedAt || '-')}"],
    [
      'class="batch-query-summary">${summaryText}',
      'class="batch-query-summary">${escapeHtml(summaryText)}'
    ]
  ];
  for (const [anchor, replacement] of replacements)
    source = replaceOne(source, anchor, replacement);
  source = replaceOne(source, "        let verifiedCdk = '';", `        let verifiedCdk = '';
        window.idRechargeClearTransient = () => {
            if (activationLocked) return;
            verifiedCdk = '';
            cdkInput.value = '';
            cdkInput.readOnly = false;
            tokenInput.value = '';
            startBtn.disabled = true;
            redeemBtn.hidden = false;
            backToStep1.hidden = true;
            tokenInput.dispatchEvent(new Event('input', { bubbles: true }));
        };`);
  return source;
}

function adaptRechargeProgress(source, workspace) {
  const replacements = [
    ['<span>开通进度</span>', '<strong id="taskProgressTitle">开通中</strong>'],
    [
      '<p id="taskProgressText" class="task-progress-text"></p>',
      '<p id="taskProgressText" class="task-progress-text" aria-live="polite"></p>\n' +
        '                <p id="taskProgressHint" class="task-progress-hint" aria-live="polite"></p>'
    ],
    ["const START_SUCCESS_TEXT = '激活成功';", "const START_SUCCESS_TEXT = '开通成功';"],
    [
      "setProgress(3, '正在恢复任务进度...');",
      workspace
        ? "window.idRechargeWorkspaceLog?.receipt('兑换码关联一笔进行中的任务，正在恢复读取。');\n                        applyTaskState({ status: 'running' }, false);"
        : "applyTaskState({ status: 'running' });"
    ],
    ["                        showStatus(data.data?.message || '检测到当前 CDK 正在开通中，正在恢复任务进度...', 'success');", ''],
    ["setProgress(3, '正在启动自动化...', 'running', { force: true });", "setProgress(0, '正在确认提交结果…', 'submitting');" +
      (workspace ? "\n            window.idRechargeWorkspaceLog?.beginSubmission();" : '')],
    ["setProgress(8, '任务已启动，正在开通中...');", workspace
      ? "window.idRechargeWorkspaceLog?.receipt('服务已受理提交，开始读取执行记录。');\n                    applyTaskState({ ...data, status: 'running' }, false);"
      : "applyTaskState({ ...data, status: 'running' });"],
    ["                    showStatus('任务已启动，正在为您开通中...', 'success');", ''],
    ['                        initWebSocket(data.data.jobKey);\n', ''],
    ['                    initWebSocket(data.jobKey);\n', ''],
    ['            clearTimeout(reconnectTimer);', ''],
    [
      '            taskProgressValue = 0;',
      "            taskProgressValue = 0;\n            setProgressHint('');"
    ],
    [
      "            const maxAllowed = (type === 'success' || type === 'error') ? 100 : 99;",
      "            const maxAllowed = type === 'success' ? 100 : 99;\n            taskProgress.dataset.state = type;"
    ],
    [
      '            taskProgressPercent.textContent = `${next}%`;',
      `            taskProgressPercent.textContent = next + '%';
            const titles = { submitting: '正在提交', running: '开通中', success: '开通成功',
                review: '开通结果待核对', error: '本次开通未完成' };
            document.getElementById('taskProgressTitle').textContent = titles[type];`
    ],
    ["                taskProgressText.textContent = label || '';", "                if (taskProgressText.textContent !== label) taskProgressText.textContent = label;"],
    [
      "                    const statusClass = isProcessing ? 'processing' : (isUsed ? 'used' : 'unused');",
      "                    const statusClass = isProcessing ? 'processing' : (isUsed ? 'used' : 'unused');\n" +
        '                    if (queryInput.value.trim() !== cdk || !querySection.checkVisibility()) return;\n' +
        '                    const taskSummary = queryTaskSummary(data.data);'
    ],
    [
      '<div class="query-row"><span>当前状态</span><strong class="status-${statusClass}">${escapeHtml(statusText)}</strong></div>',
      '<div class="query-row"><span>兑换码状态</span><strong class="status-${statusClass}">${escapeHtml(statusText)}</strong></div>\n' +
        '                            ${taskSummary ? `<div class="query-row"><span>开通进度</span><strong data-recharge-query-stage>${escapeHtml(taskSummary)}</strong></div>` : \'\'}'
    ],
    [
      "                    showStatus(resultHtml, isUsed ? 'error' : 'success', true);",
      "                    showStatus(resultHtml, isUsed ? 'error' : 'success', true);\n" +
        "                    const stageNode = statusMsg.querySelector('[data-recharge-query-stage]');\n" +
        "                    if (stageNode) void lookupQueryTaskSummary(data.data).then((label) => {\n" +
        "                        if (stageNode.isConnected && queryInput.value.trim() === cdk) stageNode.textContent = label;\n" +
        "                    });"
    ],
    [
      '<span class="status-${getBatchStatusClass(item.status)}">${escapeHtml(item.status)}</span>',
      '<div class="batch-query-state"><span class="status-${getBatchStatusClass(item.status)}">${escapeHtml(item.status)}</span>\n' +
        '                    ${queryTaskSummary(item) ? `<small>${escapeHtml(queryTaskSummary(item))}</small>` : \'\'}</div>'
    ]
  ];
  source = replaceSection(source, '        let socket = null;', 'function resetRedeemFlow(options = {}) {', `
        const openingStages = ${JSON.stringify(RECHARGE_STAGE_LABELS)};
        ${workspace ? 'const openingSteps = ' + JSON.stringify(RECHARGE_STEP_LABELS) + ';' : ''}
        const openingResults = {
            success: { title: '开通成功', tone: 'success', flow: 'success', label: '请前往 ChatGPT 查看目标账号的订阅状态。', button: START_SUCCESS_TEXT },
            failed: { title: '本次开通未完成', tone: 'error', flow: 'failed', label: '执行失败，请联系客服处理。', button: START_FAILED_TEXT },
            manual: { title: '开通结果待核对', tone: 'review', flow: 'manual', label: '结果待核实，请勿重复充值，请联系客服处理。', button: '待核对' },
            maintenance: { title: '本次开通未完成', tone: 'error', flow: 'failed', label: '服务暂时不可用，请用原兑换码查询。', button: START_FAILED_TEXT }
        };
        let activeJobKey = '';
        let taskCompleted = false;
        let taskStatusPollTimer = null;
        let taskStatusRequest = null;
        ${workspace ? "window.idRechargeRefreshTask = () => pollTaskStatus(activeJobKey);" : ''}

        function stageLabel(stage) {
            return Object.hasOwn(openingStages, stage) ? openingStages[stage] : '处理中';
        }

        function taskOutcome(data, status) {
            if (status === 'failed' && (data.manualReview === true || /转人工|人工确认|待核实/.test(String(data.message || ''))))
                return 'manual';
            return status;
        }

        function queryTaskSummary(data) {
            const status = data.taskStatus || (data.status === '开通中' ? 'running' : null);
            if (status === 'running') return stageLabel(data.stage);
            return Object.hasOwn(openingResults, status) ? openingResults[status].title : '';
        }

        function validRechargeJobKey(jobKey) {
            return typeof jobKey === 'string' && /^[\\w-]{1,128}$/.test(jobKey);
        }

        async function readRechargeTask(jobKey, withSteps = false) {
            const response = await fetch('/api/task-status/' + encodeURIComponent(jobKey) + (withSteps ? '?view=steps' : ''), {
                cache: 'no-store', signal: AbortSignal.timeout(10000)
            });
            if (!response.ok) throw new Error('任务进度暂不可用');
            const result = await response.json();
            const data = result.data;
            if (result.success !== true || data?.jobKey !== jobKey ||
                (data.status !== 'running' && !Object.hasOwn(openingResults, data.status)))
                throw new Error('任务进度回执不完整');
            return data;
        }

        async function lookupQueryTaskSummary(data) {
            const initial = queryTaskSummary(data);
            if ((data.taskStatus || (data.status === '开通中' ? 'running' : null)) !== 'running' ||
                !validRechargeJobKey(data.jobKey) || Object.hasOwn(openingStages, data.stage)) return initial;
            try {
                const task = await readRechargeTask(data.jobKey);
                return queryTaskSummary({ taskStatus: taskOutcome(task, task.status), stage: task.stage }) || initial;
            } catch { return initial; }
        }

        function clearTaskStatusPolling() {
            clearTimeout(taskStatusPollTimer);
            taskStatusPollTimer = null;
        }

        async function pollTaskStatus(jobKey) {
            if (!jobKey || taskCompleted || activeJobKey !== jobKey || taskStatusRequest?.jobKey === jobKey) return;
            const request = { jobKey };
            taskStatusRequest = request;
            clearTaskStatusPolling();
            ${workspace ? 'window.idRechargeWorkspaceLog?.refreshing(true);\n            let nextReadDelay = 1500;' : ''}
            try {
                const data = await readRechargeTask(jobKey${workspace ? ', true' : ''});
                if (activeJobKey === jobKey && taskStatusRequest === request) {
                    ${workspace ? 'window.idRechargeWorkspaceLog?.connected(data.stepsAvailable);' : ''}
                    applyTaskState(data);
                }
            } catch {
                if (activeJobKey === jobKey && taskStatusRequest === request && !taskCompleted) {
                    setProgressHint('正在重新连接，已保留上次进度。');
                    ${workspace ? 'window.idRechargeWorkspaceLog?.disconnected(); nextReadDelay = 3000;' : ''}
                }
            } finally {
                if (taskStatusRequest === request) {
                    taskStatusRequest = null;
                    ${workspace ? 'window.idRechargeWorkspaceLog?.refreshing(false);' : ''}
                    if (activeJobKey === jobKey && !taskCompleted)
                        taskStatusPollTimer = setTimeout(() => pollTaskStatus(jobKey), ${workspace ? 'nextReadDelay' : '5000'});
                }
            }
        }

        function startTaskStatusPolling(jobKey) {
            clearTaskStatusPolling();
            activeJobKey = jobKey;
            ${workspace ? "window.idRechargeWorkspaceLog?.state('running');" : ''}
            pollTaskStatus(jobKey);
        }

        function setProgressHint(text) {
            const hint = document.getElementById('taskProgressHint');
            if (hint.textContent !== text) hint.textContent = text;
        }
  `);
  source = replaceSection(source, 'function applyTaskState(data) {', "startBtn.addEventListener('click'", `
        function applyTaskState(data${workspace ? ', recordReceipt = true' : ''}) {
            const status = taskOutcome(data, data.status);
            if (taskCompleted || (status !== 'running' && !Object.hasOwn(openingResults, status))) return;
            ${workspace ? 'const detailedStep = window.idRechargeWorkspaceLog?.syncSteps(data.steps, openingSteps);' : ''}
            const progress = Number.isFinite(data.progress) ? data.progress : taskProgressValue;
            if (Object.hasOwn(data, 'captcha')) updateCaptchaVerification(data.captcha);
            showProgress();
            statusMsg.style.display = 'none';
            if (status === 'running') {
                const needsVerification = activeCaptcha?.stage === 'awaiting_captcha' || activeCaptcha?.status === 'pending';
                const verificationSubmitted = activeCaptcha?.stage === 'captcha_submitted' || activeCaptcha?.status === 'submitted';${workspace ? `
                const useStep = data.stepsAvailable !== false && detailedStep &&
                    data.stage !== 'paid' && data.stage !== 'subscription_check';` : ''}
                const label = needsVerification ? '等待完成验证' : verificationSubmitted ? '正在确认验证结果' :
                    ${workspace ? '(useStep ? detailedStep : stageLabel(data.stage))' : 'stageLabel(data.stage)'};
                setProgress(progress, label);
                ${workspace ? 'if (recordReceipt && (!useStep || needsVerification || verificationSubmitted)) window.idRechargeWorkspaceLog?.receipt(label);' : ''}
                setProgressHint(needsVerification && !captchaVerificationBtn.disabled
                    ? '请在验证页面完成操作后返回。' : '请稍候，同一兑换码无需重复提交。');
                updateFlowUI(2, 'running');
                return;
            }

            taskCompleted = true;
            clearTaskStatusPolling();
            activeJobKey = '';
            hideCaptchaVerification();
            const result = openingResults[status];
            const succeeded = status === 'success';
            ${workspace ? "if (status === 'manual') pendingReview.add(verifiedCdk);" : ''}
            setProgress(succeeded ? 100 : progress, result.label, result.tone);
            const renewalUnconfirmed = succeeded && data.renewalUnconfirmed === true;
            setProgressHint(renewalUnconfirmed ? '自动续订取消状态未确认，请到目标账号账单页核对。' : '');
            ${workspace ? `window.idRechargeWorkspaceLog?.receipt(result.title + '。' + result.label, result.tone, data.terminalAt);
            if (renewalUnconfirmed) window.idRechargeWorkspaceLog?.receipt('自动续订取消状态未确认，请到目标账号账单页核对。', 'review');
            window.idRechargeWorkspaceLog?.state('finished');` : ''}
            updateFlowUI(2, result.flow);
            setButtonText(startBtn, result.button);
            toggleLoading(startBtn, false);
            setActivationLock(false);
            if (status === 'failed') {
                taskCompleted = false;
                ${workspace ? 'syncWorkspaceAccountLock(); updateConfirmation();' : 'startBtn.disabled = false;'}
            } else startBtn.disabled = true;
        }
  `);
  source = replaceOne(source, '            closeTaskSocket();', "            activeJobKey = '';\n            taskStatusRequest = null;" +
    (workspace ? '\n            window.idRechargeWorkspaceLog?.reset();' : ''));
  source = replaceOne(source, 'if (isProcessing && data.data?.jobKey) {', 'if (isProcessing && validRechargeJobKey(data.data?.jobKey)) {');
  source = replaceOne(source,
    workspace ? 'if (response.ok && data.success && data.jobKey) {' : 'if (data.success && data.jobKey) {',
    'if (response.ok && data.success === true && validRechargeJobKey(data.jobKey)) {');
  for (const [anchor, replacement] of replacements) source = replaceOne(source, anchor, replacement);
  if (workspace) {
    source = replaceOne(source,
      "                    querySection.style.display = 'none';",
      "                    querySection.style.display = 'none';\n" +
        '                    if (taskProgress.dataset.state) showProgress();'
    );
    source = replaceOne(source,
      "                    hideProgress();\n                    setQueryMode('single');",
      "                    taskProgress.style.display = 'none';\n                    setQueryMode('single');"
    );
    source = replaceOne(source,
      "            taskProgress.style.display = 'none';\n            resetProgressState();",
      "            taskProgress.style.display = 'none';\n            delete taskProgress.dataset.state;\n            resetProgressState();"
    );
  }
  return source;
}

function adaptWorkspaceRecharge(source) {
  const progressStart = source.indexOf('<div id="taskProgress"');
  const progressEnd = source.indexOf('<div id="statusMessage"', progressStart);
  if (progressStart < 0 || progressEnd < 0) throw new Error('上游界面缺少充值进度区');
  // Move the native progress and verification nodes together so the same task drives both.
  const taskProgress = source.slice(progressStart, progressEnd);
  source = replaceOne(source, taskProgress, '');
  source = replaceSection(
    source,
    '<header class="site-hero">',
    '<div id="redeemSection">',
    `
    <div class="workspace-recharge-standalone-title"><h1>ChatGPT 兑换开通</h1><p>资料核对、自动处理、进度可查、套餐锁定。验码后自动匹配套餐，请核对账号再提交。</p></div>
    <main class="recharge-card">
      <header class="workspace-recharge-heading">
        <nav class="tab-nav tabs" aria-label="兑换开通功能">
          <button type="button" class="tab-btn tab active" data-tab="redeem" aria-pressed="true" aria-controls="redeemSection">自助充值</button>
          <button type="button" class="tab-btn tab" data-tab="query" aria-pressed="false" aria-controls="querySection">兑换码查询</button>
          <button type="button" class="tab-btn tab" data-tab="guide" aria-pressed="false" aria-controls="workspaceGuide">使用说明</button>
        </nav>
        <div class="workspace-recharge-heading-actions">
          <a class="btn-secondary" href="/subscription" target="_blank" rel="noopener">${workspaceIcon('receipt')}发票助手</a>
        </div>
      </header>
      <div class="workspace-recharge-body">
      <div id="workspaceOperation">
        <div id="flowStepper" hidden></div>
        <p id="paymentRegionHint" hidden></p>
  `
  );
  source = replaceSection(
    source,
    '<div id="step1">',
    '<div id="querySection"',
    `
  <div class="workspace-recharge-form">
    <section id="step1" class="workspace-recharge-step" aria-labelledby="workspace-code-title">
      <h2 id="workspace-code-title"><span>01</span> 验证兑换码</h2>
      <p class="field-hint">实际充值套餐以兑换码绑定结果为准。</p>
      <div class="workspace-recharge-field">
        <label for="cdkInput">兑换码</label>
        <div class="workspace-code-controls">
          <input type="text" id="cdkInput" placeholder="请输入兑换码" maxlength="32" autocomplete="off" spellcheck="false">
          <div class="workspace-code-actions">
            <div class="workspace-clipboard-actions" data-workspace-clipboard="cdkInput">
              <button type="button" class="btn-secondary" data-paste aria-label="粘贴兑换码">粘贴</button>
              <button type="button" class="btn-secondary" data-clear aria-label="清空兑换码" disabled>清空</button>
            </div>
            <button type="button" id="redeemBtn" class="btn-primary"><span class="btn-text">验证兑换码</span><span class="loader"></span></button>
            <button type="button" id="backToStep1" class="btn-secondary" hidden>更换兑换码</button>
          </div>
          <p id="workspaceVerifiedPlan" class="workspace-recharge-verified" role="status" hidden></p>
          <p class="field-hint workspace-clipboard-status" id="cdkInputClipboardStatus" role="status"></p>
        </div>
      </div>
    </section>
    <fieldset id="step2" class="workspace-recharge-step" disabled>
      <legend class="workspace-recharge-legend">填写账号并提交</legend>
      <h2 id="workspace-account-title"><span>02</span> 填写账号并提交</h2>
      <p class="field-hint">账号资料仅用于本次充值，请勿转发。<a class="workspace-guide-link" href="#workspaceGuide" data-workspace-tab="guide">如何获取账号资料？</a></p>
      <div class="workspace-recharge-field workspace-recharge-field--account">
        <label for="tokenInput">账号资料（JSON）</label>
        <div class="workspace-recharge-account">
          <textarea id="tokenInput" placeholder="请粘贴完整账号资料" rows="4" autocomplete="off" spellcheck="false" aria-describedby="workspaceAccountHint"></textarea>
          <div class="workspace-clipboard-actions" data-workspace-clipboard="tokenInput">
            <button type="button" class="btn-secondary" data-paste aria-label="粘贴账号资料">粘贴</button>
            <button type="button" class="btn-secondary" data-clear aria-label="清空账号资料" disabled>清空</button>
          </div>
          <p class="field-hint" id="tokenInputClipboardStatus" role="status"></p>
          <p id="workspaceAccountHint" class="field-hint" aria-live="polite"></p>
        </div>
      </div>
      <div class="workspace-recharge-footer">
        <dl class="workspace-recharge-summary">
          <div><dt>目标账号</dt><dd id="workspaceAccount">填写后显示</dd></div>
          <div><dt>充值套餐</dt><dd id="workspacePlan">验码后确认</dd></div>
        </dl>
        <button type="button" id="startBtn" class="btn-primary" disabled><span class="btn-text">充值提交</span><span class="loader"></span></button>
      </div>
    </fieldset>
  </div>
  <aside class="workspace-recharge-progress" aria-labelledby="workspace-progress-title">
    <div class="workspace-progress-heading">
      <h2 id="workspace-progress-title">充值进度</h2>
      <span id="flowStatusBadge" class="flow-badge pending" role="status">待开始</span>
    </div>
    <div class="workspace-progress-idle">
      <p>提交后，这里会显示当前处理阶段和结果。</p>
      <p>提交结果待核对，请用原兑换码查询。</p>
    </div>
    ${taskProgress}
    <section class="workspace-log" aria-labelledby="workspace-log-title">
      <div class="workspace-log-toolbar">
        <h3 id="workspace-log-title">实时操作记录</h3>
        <p id="workspace-log-help">显示本页收到的任务状态和原服务实际记录的执行事件。执行事件用记录时间，页面操作和状态回执用本页时间，均为北京时间。运行时每 1.5 秒尝试更新，向上滚动可暂停跟随。</p>
        <div class="workspace-log-actions">
          <label class="workspace-log-follow"><input id="workspaceLogFollow" type="checkbox" checked>自动滚动</label>
          <button type="button" id="workspaceLogRefresh" class="btn-secondary" disabled>刷新</button>
        </div>
      </div>
      <div id="workspaceLogViewport" class="workspace-log-viewport" tabindex="0" role="region" aria-label="本次充值运行日志">
        <p id="workspaceLogEmpty" class="workspace-log-empty">验证兑换码后，这里会记录本次操作。</p>
        <ol id="workspaceLogEntries" class="workspace-log-entries" role="log" aria-label="本次操作记录" aria-live="polite" aria-relevant="additions"></ol>
      </div>
      <div class="workspace-log-footer">
        <span id="workspaceLogStatus" role="status">等待验证兑换码</span>
        <button type="button" id="workspaceLogLatest" class="btn-secondary" hidden>回到最新</button>
      </div>
    </section>
  </aside>
</div>
  `
  );
  source = replaceOne(source, '<div id="querySection" style="display: none;">', `
    <div id="querySection" style="display: none;">
      <div class="workspace-query-heading">
        <h2 id="workspace-query-title">${workspaceIcon('search')}查询充值结果</h2>
        <p>输入原兑换码，查看套餐与充值进度。</p>
      </div>`);
  source = replaceOne(source, 'for="queryInput">输入卡密查询状态', 'for="queryInput">兑换码');
  source = replaceOne(source, 'placeholder="请输入要查询的激活码"', 'placeholder="请输入需要查询的兑换码"');
  source = replaceOne(source, 'for="batchQueryInput">批量输入卡密', 'for="batchQueryInput">批量兑换码');
  source = replaceSection(
    source,
    '        </main>\n\n        <details class="faq-panel">',
    '    </div>\n\n    <script>',
    `</div>${workspaceGuide}</div></main>`
  );
  return adaptWorkspaceRechargeScript(source);
}

function adaptWorkspaceRechargeScript(source) {
  const replace = (anchor, value) => {
    source = replaceOne(source, anchor, value);
  };
  replace("        const step1 = document.getElementById('step1');", '');
  replace(
    "        let verifiedCdk = '';",
    `
        let currentOperation = 'redeem';
        let verifiedCdk = '';
        const account = document.getElementById('workspaceAccount');
        const accountHint = document.getElementById('workspaceAccountHint');
        const plan = document.getElementById('workspacePlan');
        const verifiedPlan = document.getElementById('workspaceVerifiedPlan');
        const pendingReview = new Set();
        function syncWorkspaceAccountLock() {
            tokenInput.readOnly = activationLocked || taskCompleted || pendingReview.has(verifiedCdk) ||
                tokenInput.dataset.demoReadonly === 'true';
        }
        function setWorkspaceVerified(verified) {
            cdkInput.readOnly = verified;
            redeemBtn.hidden = verified;
            backToStep1.hidden = !verified;
            step2.disabled = !verified;
            syncWorkspaceAccountLock();
        }
        function updateConfirmation() {
            const result = validateSessionInput(tokenInput.value, { silent: true });
            account.textContent = result.valid && result.email ? result.email : '填写后显示';
            accountHint.textContent = tokenInput.value.trim() && !result.valid ? result.message : '';
            startBtn.disabled = !verifiedCdk || !result.valid || activationLocked ||
                taskCompleted || pendingReview.has(verifiedCdk);
        }
        function markUncertain() {
            pendingReview.add(verifiedCdk);
            setActivationLock(false);
            tokenInput.value = '';
            hideProgress();
            updateFlowUI(2, 'manual');
            toggleLoading(startBtn, false);
            startBtn.disabled = true;
            setButtonText(startBtn, '待核对');
            showStatus('提交结果暂时无法确认，请用原兑换码查询。', 'error');
            window.idRechargeWorkspaceLog?.record('提交结果待核对，请用原兑换码查询，勿重复充值。', 'review');
            window.idRechargeWorkspaceLog?.state('uncertain');
        }
  `
  );
  replace(
    "const START_DEFAULT_TEXT = '确认并启动自动化开通';",
    "const START_DEFAULT_TEXT = '充值提交';"
  );
  replace("cdk_ok: '待提交 Session'", "cdk_ok: '待核对账号'");
  replace(
    "                const tab = btn.dataset.tab;",
    `
                for (const tabButton of tabButtons)
                    tabButton.setAttribute('aria-pressed', String(tabButton === btn));
                const tab = btn.dataset.tab;
                const showGuide = tab === 'guide';
                document.getElementById('workspaceGuide').hidden = !showGuide;
                document.getElementById('workspaceOperation').hidden = showGuide;
                flowStatusBadge.hidden = tab !== 'redeem';
                if (showGuide || tab === currentOperation) return;
                currentOperation = tab;
  `
  );
  replace("redeemSection.style.display = 'block';", "redeemSection.style.display = 'grid';");
  replace(
    "                    querySection.style.display = 'block';",
    `
                    querySection.style.display = 'block';
                    if (verifiedCdk && !queryInput.value.trim()) queryInput.value = verifiedCdk;
  `
  );
  source = replaceSection(
    source,
    'function applyTokenInput(',
    "redeemBtn.addEventListener('click'",
    `
        tokenInput.addEventListener('input', updateConfirmation);
        cdkInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !redeemBtn.hidden) redeemBtn.click();
        });
  `
  );
  replace(
    '            toggleLoading(redeemBtn, true);',
    `
            redeemBtn.disabled = true;
            cdkInput.readOnly = true;
            window.idRechargeWorkspaceLog?.reset();
            window.idRechargeWorkspaceLog?.state('verifying');
            window.idRechargeWorkspaceLog?.record('开始验证兑换码。');
            toggleLoading(redeemBtn, true);
  `
  );
  replace(
    '                    verifiedCdk = cdk;',
    `
                    verifiedCdk = cdk;
                    const planType = data.data?.plan_type;
                    const matchedPlan = Object.hasOwn(PLAN_LABELS, planType)
                        ? (typeof data.data.plan_label === 'string' && data.data.plan_label.trim()) || PLAN_LABELS[planType]
                        : '';
                    setWorkspaceVerified(true);
                    plan.textContent = matchedPlan || '套餐待确认';
                    verifiedPlan.textContent = matchedPlan ? '已锁定套餐 · ' + matchedPlan : '套餐待确认';
                    verifiedPlan.hidden = false;
                    window.idRechargeWorkspaceLog?.receipt(matchedPlan
                        ? '兑换码验证通过，已确认套餐。' : '兑换码验证通过，套餐待确认。');
                    window.idRechargeWorkspaceLog?.state('verified');
  `
  );
  source = source
    .replaceAll("step1.style.display = 'none';", '')
    .replaceAll("step2.style.display = 'block';", '');
  source = replaceSection(
    source,
    "updateFlowUI(2, 'cdk_ok');",
    '} else {\n                    showStatus(data.message',
    `
                    updateFlowUI(2, pendingReview.has(verifiedCdk) ? 'manual' : 'cdk_ok');
                    updateConfirmation();
                    if (pendingReview.has(verifiedCdk)) {
                        showStatus('该兑换码有待核对的提交，请先查询。', 'error');
                    } else {
                        statusMsg.style.display = 'none';
                    }
  `
  );
  replace(
    "                    showStatus(data.message || '兑换码无效或已使用', 'error');",
    `                    window.idRechargeWorkspaceLog?.receipt('兑换码未通过校验，请查看页面提示。', 'review');
                    window.idRechargeWorkspaceLog?.state('idle');
                    showStatus(data.message || '兑换码无效或已使用', 'error');`
  );
  replace(
    "                showStatus('网络请求失败', 'error');\n            } finally {\n                toggleLoading(redeemBtn, false);",
    `                window.idRechargeWorkspaceLog?.record('暂时无法读取兑换码校验结果。', 'review');
                window.idRechargeWorkspaceLog?.state('idle');
                showStatus('网络请求失败', 'error');
            } finally {
                toggleLoading(redeemBtn, false);`
  );
  replace(
    '                toggleLoading(redeemBtn, false);',
    `
                toggleLoading(redeemBtn, false);
                redeemBtn.disabled = false;
                if (!verifiedCdk) cdkInput.readOnly = false;
  `
  );
  replace(
    "            startBtn.disabled = false;\n            setButtonText(startBtn, START_DEFAULT_TEXT);\n            step2.style.display = 'none';\n            step1.style.display = 'block';",
    `
            startBtn.disabled = true;
            setButtonText(startBtn, START_DEFAULT_TEXT);
            setWorkspaceVerified(false);
            account.textContent = '填写后显示';
            accountHint.textContent = '';
            plan.textContent = '验码后确认';
            verifiedPlan.hidden = true;
            verifiedPlan.textContent = '';
  `
  );
  source = replaceSection(
    source,
    "const infoDiv = document.getElementById('redeemCdkInfo');",
    'if (!preserveStatus)',
    ''
  );
  replace(
    '            const rawSession = tokenInput.value.trim();',
    `
            if (activationLocked || taskCompleted || pendingReview.has(verifiedCdk)) return;
            const rawSession = tokenInput.value.trim();
  `
  );
  replace(
    '            setButtonText(startBtn, START_PENDING_TEXT);',
    `
            tokenInput.readOnly = true;
            setButtonText(startBtn, START_PENDING_TEXT);
  `
  );
  replace(
    '                if (data.success && data.jobKey) {',
    `
                if (response.ok && data.success && data.jobKey) {
                    tokenInput.value = '';
  `
  );
  replace(
    "                } else {\n                    hideProgress();\n                    updateFlowUI(2, 'failed');",
    `
                } else if (response.ok || data.success !== false || (response.status >= 500 && !(
                    response.status === 503 && data.notAccepted === true && data.code === 'maintenance_mode'
                ))) {
                    markUncertain();
                } else {
                    if (data.manualReview) pendingReview.add(verifiedCdk);
                    hideProgress();
                    window.idRechargeWorkspaceLog?.receipt(data.manualReview
                        ? '开通结果待核对，请用原兑换码查询。' : '提交未受理，请检查页面提示后重试。', 'review');
                    window.idRechargeWorkspaceLog?.state('finished');
                    updateFlowUI(2, data.manualReview ? 'manual' : 'failed');
  `
  );
  replace(
    '                    startBtn.disabled = false;\n                    setActivationLock(false);',
    `
                    setActivationLock(false);
                    updateConfirmation();
  `
  );
  replace(
    "                hideProgress();\n                updateFlowUI(2, 'failed');\n                showStatus('网络连接失败，请重试', 'error');\n                setButtonText(startBtn, START_FAILED_TEXT);\n                toggleLoading(startBtn, false);\n                startBtn.disabled = false;\n                setActivationLock(false);",
    `
                markUncertain();
            } finally {
                syncWorkspaceAccountLock();
  `
  );
  replace(
    '<div id="statusMessage" class="status-message">',
    '<div id="statusMessage" class="status-message" role="status">'
  );
  replace(
    '            window.idRechargeSetNavigationLock(activationLocked);',
    '            window.idRechargeSetNavigationLock(activationLocked);\n            syncWorkspaceAccountLock();'
  );
  return replaceSection(source, '        window.idRechargeClearTransient = () => {', 'const START_DEFAULT_TEXT', `
        window.idRechargeClearTransient = () => {
            if (!activationLocked) resetRedeemFlow();
        };
  `);
}

function adaptHtml(source, kind) {
  if (kind === 'redeem' || kind === 'workspace') source = adaptRedeemHtml(source);
  if (kind === 'workspace') source = adaptWorkspaceRecharge(source);
  if (kind === 'redeem' || kind === 'workspace') source = adaptRechargeProgress(source, kind === 'workspace');
  source = source
    .replace(/^[ \t]*<link\b[^>]*https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*$/gm, '')
    .replaceAll('src="https://unpkg.com/lucide@latest"', 'src="' + prefix + '/lucide.js"')
    .replace(
      /(href|src)="\/(favicon\.svg|admin\.css|style\.css|admin\.js|subscription)(?=["?])/g,
      '$1="' + prefix + '/$2'
    )
    .replaceAll('href="/"', 'href="' + prefix + '/redeem"')
    .replaceAll("location.href='/'", "location.href='" + prefix + "/redeem'")
    .replaceAll('账单地址请在左侧', '账单地址请在上方')
    .replace(
      '<body',
      kind === 'workspace'
        ? '<body data-recharge-view="redeem" data-recharge-workspace'
        : '<body data-recharge-view="' + kind + '"'
    );
  if (kind === 'admin') {
    source = source.replaceAll('class="admin-switcher-tabs"', 'class="admin-switcher-tabs tabs"')
      .replace(/class="admin-switcher-tab(?=[" ])/g, 'class="tab admin-switcher-tab');
    const telegramPanel = '<div class="panel" style="margin-top: 24px;">\n                <h2 class="panel-title">Telegram 通知</h2>';
    source = replaceOne(source, telegramPanel, telegramPanel.replace('class="panel"', 'class="panel" data-recharge-telegram-form'));
    source = replaceOne(
      source,
      '<th width="200px">卡号</th>',
      '<th width="200px">卡号</th>\n' +
        '                                <th width="110px" scope="col">银行卡类型</th>'
    );
    source = replaceOne(
      source,
      '<textarea id="card_pool_import_text" class="import-textarea"',
      '<div class="embedded-field card-pool-import-type">' +
        '<label for="card_pool_import_type">银行卡类型<span class="required" aria-hidden="true"> *</span></label>' +
        '<select id="card_pool_import_type" class="asset-input" required disabled aria-describedby="card_pool_import_type_hint">' +
        '<option value="">请选择银行卡类型</option></select>' +
        '<p id="card_pool_import_type_hint" class="embedded-field-hint">同一批使用所选类型。已有其他类型的重复卡片可在列表修改。</p>' +
        '</div>\n                    <textarea id="card_pool_import_text" class="import-textarea"'
    );
    source = replaceOne(source, 'id="card_pool_import_btn" class="btn btn-success"',
      'id="card_pool_import_btn" class="btn btn-success" disabled');
    source = replaceOne(source, '<p id="card_pool_import_result" style=',
      '<p id="card_pool_import_result" role="status" style=');
    source = replaceOne(
      source,
      '<div class="table-container">\n                    <table class="admin-action-table card-pool-table">',
      '<div class="card-pool-type-feedback">' +
        '<span id="card_pool_type_status" role="status"></span>' +
        '<button type="button" id="card_pool_type_retry" class="btn btn-secondary" hidden>重试读取类型</button>' +
        '</div>\n                <div class="table-container">\n                    <table class="admin-action-table card-pool-table">'
    );
    source = source.replace('每次任务从「启用」的代理中随机抽取。',
      '优先检测标注国家与套餐一致的启用代理，再检测待标注旧代理。实测出口匹配才会创建任务。');
    source = replaceOne(source, '<textarea id="proxy_add_input"',
      '<div class="form-group embedded-field proxy-country-field">' +
        '<label for="proxy_add_country">代理国家 <span class="proxy-country-required" aria-hidden="true">*</span></label>' +
        '<select id="proxy_add_country" class="asset-input" required disabled aria-describedby="proxy_add_hint">' +
        '<option value="">正在读取国家选项…</option></select></div>\n                <textarea id="proxy_add_input"');
    source = replaceOne(source, `onclick="document.getElementById('proxy_add_input').value=''"`, 'onclick="clearProxyPoolEditor()"');
    source = replaceOne(source, '<th width="140px">出口 IP</th>',
      '<th scope="col" class="proxy-country-cell">标注国家</th>\n' +
        '                                <th scope="col" class="proxy-exit-cell">实测出口</th>');
    source = replaceOne(source, '<tbody id="proxy_pool_body">\n                            <tr><td colspan="7">',
      '<tbody id="proxy_pool_body">\n                            <tr><td colspan="8">');
    source = source.replace('>支付地区设置</h2>', '>其他流程默认地区</h2>')
      .replace('选择支付地区后，系统将使用对应的币种进行 Stripe 支付。账单地址请在上方「免税地址」页面管理。',
        '此设置保留给其他原有流程。自动充值和支付页面调试统一使用上方套餐线路配置；账单地址仍沿用美国地址库。');
    source = replaceOne(
      source,
      '<label style="margin-bottom: 6px;">plan_name（自动跟随套餐，可手动改）</label>',
      '<label for="checkout_plan_name">套餐代码</label>'
    );
    source = replaceOne(
      source,
      'id="checkout_plan_name" class="asset-input" placeholder="chatgptplusplan" autocomplete="off">',
      'id="checkout_plan_name" class="asset-input" placeholder="chatgptplusplan" autocomplete="off" aria-describedby="checkout-plan-help">\n' +
        '<p id="checkout-plan-help" class="embedded-field-hint">自动跟随套餐，可手动修改。</p>'
    );
    source = source.replace(
      /\s*<div class="nav-item" onclick="logoutAdmin\(\)">[\s\S]*?<\/div>/,
      ''
    );
    source = replaceSection(
      source,
      '<div class="panel" style="margin-top: 24px;">\n                <h2 class="panel-title">修改后台密码</h2>',
      '<!-- 支付地区设置 -->',
      ''
    );
    source = replaceOne(source, '<!-- 支付地区设置 -->', routingAdminPanel + '\n<!-- 支付地区设置 -->');
    source = replaceOne(
      source,
      '<div style="display: flex; align-items: center; gap: 12px; margin-top: 18px; flex-wrap: wrap;">\n' +
        '                    <div class="form-group" style="margin-bottom: 0; flex: 1; min-width: 180px; max-width: 280px;">\n' +
        '                        <label style="margin-bottom: 6px;">当前支付地区</label>',
      '<div class="form-group embedded-field-with-actions">\n' +
        '                    <label for="region_selector">默认地区</label>\n' +
        '                    <div class="embedded-control-row">'
    );
    source = replaceOne(
      source,
      '                    </div>\n' +
        '                    <button class="btn btn-primary" style="margin-top: 20px;" onclick="savePaymentRegion()">',
      '                        <button type="button" class="btn btn-primary" onclick="savePaymentRegion()">'
    );
    source = replaceOne(
      source,
      '<span id="region_current_badge" class="status-badge status-success" style="margin-top: 20px;"></span>',
      '    <span id="region_current_badge" class="status-badge status-success" role="status"></span>\n' +
        '                    </div>'
    );
    source = replaceOne(
      source,
      '<div style="display: flex; align-items: center; gap: 12px; margin-top: 16px; flex-wrap: wrap;">\n' +
        '                    <button class="btn btn-primary" onclick="startCheckoutDebug()"',
      '<div class="embedded-control-row embedded-control-row--spaced">\n' +
        '                    <button class="btn btn-primary" onclick="startCheckoutDebug()"'
    );
    source = replaceOne(
      source,
      '<div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-top: 16px;">\n' +
        '                    <button type="button" class="btn btn-danger" id="cancel_renewal_btn"',
      '<div class="embedded-control-row embedded-control-row--spaced">\n' +
        '                    <button type="button" class="btn btn-danger" id="cancel_renewal_btn"'
    );
  }
  source = source.replace(
    '</head>',
    '<link rel="stylesheet" href="' +
      prefix +
      '/shell.css">\n' +
      '<link rel="stylesheet" href="/title-help.css">\n' +
      '<script src="/title-help.js" defer></script>\n' +
      '<script src="' +
      prefix +
      '/shell.js"></script>\n</head>'
  );
  return localUrls(source);
}

async function buildCodexdaichongAssets() {
  const [
    redeem,
    admin,
    subscription,
    adminJs,
    adminCss,
    publicCss,
    favicon,
    lucide,
    shell,
    styles,
    routingScript,
    paginationScript,
    paginationStyles,
    designTokens,
    tabStyles
  ] = await Promise.all([
    original('index.html'),
    original('admin.html'),
    original('subscription.html'),
    original('admin.js'),
    original('admin.css'),
    original('style.css'),
    original('favicon.svg'),
    readFile(new URL('vendor/lucide/lucide.min.js', import.meta.url)),
    readFile(new URL('shell.js', import.meta.url)),
    readFile(new URL('shell.css', import.meta.url)),
    readFile(new URL('routing-admin.js', import.meta.url), 'utf8'),
    readFile(new URL('../../../frontend/pagination.js', import.meta.url), 'utf8'),
    readFile(new URL('../../../frontend/pagination.css', import.meta.url), 'utf8'),
    readFile(new URL('../../../frontend/design-tokens.css', import.meta.url), 'utf8'),
    readFile(new URL('../../../frontend/tabs.css', import.meta.url), 'utf8')
  ]);
  const assets = new Map();
  for (const [path, source, kind] of [
    ['/redeem', redeem, 'redeem'],
    ['/workspace', redeem, 'workspace'],
    ['/admin', admin, 'admin'],
    ['/subscription', subscription, 'subscription']
  ]) {
    const proxyHelp = '先选择代理国家，同一批共用所选国家，每行录入一条。支持完整代理链接、主机:端口:账号:密码、账号:密码@主机:端口。未带协议默认 SOCKS5。';
    const html = kind === 'admin' ? replaceOne(source,
      '粘贴一条或多条代理 URL（一行一条），点保存后立即写入代理池并在下方列表显示。', proxyHelp)
      .replace('socks5://user:pass@host:port\n', 'socks5://host:port:user:pass\nhost:port:user:pass\n') : source;
    const body = adaptHtml(html, kind);
    assets.set(path, {
      body,
      type: media.html,
      csp: [
        "default-src 'none'",
        ["script-src 'self'", ...inlineHashes(body)].join(' '),
        "script-src-attr 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'self'",
        "form-action 'none'"
      ].join('; ')
    });
  }
  for (const [name, body, kind] of [
    ['admin.js', paginationScript + '\n' + adaptAdminScript(adminJs, routingScript), 'js'],
    ['admin.css', adminCss, 'css'],
    ['style.css', publicCss, 'css'],
    ['favicon.svg', favicon, 'svg'],
    ['lucide.js', lucide, 'js'],
    ['shell.js', shell, 'js'],
    ['shell.css', designTokens + '\n' + paginationStyles + '\n' + tabStyles + '\n' + styles, 'css']
  ])
    assets.set('/' + name, { body, type: media[kind] });
  return assets;
}

export async function loadCodexdaichongAssets({ requireBundle = false } = {}) {
  const path = process.env.ID_CODEXDAICHONG_ASSETS_FILE;
  if (!path && !requireBundle) return buildCodexdaichongAssets();
  try {
    if (!path || !isAbsolute(path)) throw new Error();
    const file = await stat(path);
    if (!file.isFile() || file.size > 8 * 1024 * 1024) throw new Error();
    const { revision, assets } = JSON.parse(await readFile(path, 'utf8'));
    if (revision !== CODEXDAICHONG_REVISION || Object.keys(assets).length !== Object.keys(bundledPaths).length)
      throw new Error();
    const entries = Object.entries(bundledPaths).map(([route, kind]) => {
      const { body, type, csp } = assets[route];
      if (typeof body !== 'string' || !body.length || type !== media[kind] ||
          (kind === 'html' ? typeof csp !== 'string' || !csp.startsWith("default-src 'none'") : csp !== undefined))
        throw new Error();
      return [route, { body, type, ...(csp ? { csp } : {}) }];
    });
    return new Map(entries);
  } catch {
    throw new Error('无法读取当前版本的线上代充页面制品');
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const output = process.argv[2];
    if (process.argv.length !== 3 || !isAbsolute(output))
      throw new Error('请指定代充页面制品的绝对输出路径');
    const assets = await buildCodexdaichongAssets();
    const entries = Array.from(assets, ([route, value]) => [route, { ...value, body: value.body.toString() }]);
    await writeFile(output, JSON.stringify({
      revision: CODEXDAICHONG_REVISION, assets: Object.fromEntries(entries)
    }), { flag: 'wx', mode: 0o644 });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
