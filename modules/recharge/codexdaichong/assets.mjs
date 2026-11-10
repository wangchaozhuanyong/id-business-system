import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { CODEXDAICHONG_REVISION } from './prepare.mjs';
import { workspaceGuide, workspaceIcon } from './workspace-guide.mjs';
import { normalizeRechargeProxyInput } from './proxy-input.mjs';
import { RECHARGE_STAGE_LABELS } from './progress-presentation.mjs';
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
        ].map(key => [key, { page: 1, pageSize: 10 }]));`);
  source = replaceSection(source, '        function changePage(', '        function getItemKey(', `
        const adminPageSizes = [10, 20, 50];
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
    '        const orbitcardUsageState = {\n            page: 1,\n            pageSize: 10,');
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
        });
        async function saveProxyPool() {
            const input = document.getElementById('proxy_add_input');
            const hint = document.getElementById('proxy_add_hint');
            if (!input || input.dataset.saving === 'true') return;
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
            if (hint) hint.textContent = '正在保存 ' + batch.proxies.length + ' 条代理…';
            try {
                const res = await authFetch('/api/admin/proxies', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ proxies: batch.proxies })
                });
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || data.message || '保存失败');
                if (input.value === submitted) input.value = '';
                if (hint) hint.textContent = data.message || '代理已保存';
                showMessage(data.message || '代理已保存', 'success');
                await loadProxyPool();
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
    '<tr><td colspan="10" style="text-align:center; color: var(--text-dim); padding: 40px 0;">暂无卡片，请使用批量导入添加</td></tr>',
    '<tr><td colspan="11" style="text-align:center; color: var(--text-dim); padding: 40px 0;">暂无卡片，请使用批量导入添加</td></tr>'
  );
  source = replaceOne(
    source,
    '<td><code>${cardNumber}</code></td>',
    '<td><code>${cardNumber}</code></td>\n' +
      '                    <td data-recharge-card-type="${rechargeCardTypes.cardKey(card.id)}"></td>'
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
        const rechargeCardTypes = (${createRechargeCardTypeOverlay.toString()})({
            async fetchSettings() {
                const response = await authFetch('/api/local/card-types', {
                    cache: 'no-store', signal: AbortSignal.timeout(5000)
                });
                if (!response.ok) throw new Error('无法读取银行卡类型');
                return response.json();
            },
            onChange: paintRechargeCardTypes
        });
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
            for (const cell of document.querySelectorAll('#card_pool_list_body [data-recharge-card-type]'))
                cell.textContent = rechargeCardTypes.label(cell.dataset.rechargeCardType);
        }
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
      "applyTaskState({ status: 'running' });"
    ],
    ["                        showStatus(data.data?.message || '检测到当前 CDK 正在开通中，正在恢复任务进度...', 'success');", ''],
    ["setProgress(3, '正在启动自动化...', 'running', { force: true });", "setProgress(0, '正在确认提交结果…', 'submitting');" +
      (workspace ? "\n            window.idRechargeWorkspaceLog?.reset();\n            window.idRechargeWorkspaceLog?.state('submitting');\n            window.idRechargeWorkspaceLog?.record('正在提交，等待服务确认。');" : '')],
    ["setProgress(8, '任务已启动，正在开通中...');", "applyTaskState({ ...data, status: 'running' });"],
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

        async function readRechargeTask(jobKey) {
            const response = await fetch('/api/task-status/' + encodeURIComponent(jobKey), {
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
            ${workspace ? 'window.idRechargeWorkspaceLog?.refreshing(true);' : ''}
            try {
                const data = await readRechargeTask(jobKey);
                if (activeJobKey === jobKey && taskStatusRequest === request) {
                    ${workspace ? 'window.idRechargeWorkspaceLog?.connected();' : ''}
                    applyTaskState(data);
                }
            } catch {
                if (activeJobKey === jobKey && taskStatusRequest === request && !taskCompleted) {
                    setProgressHint('正在重新连接，已保留上次进度。');
                    ${workspace ? 'window.idRechargeWorkspaceLog?.disconnected();' : ''}
                }
            } finally {
                if (taskStatusRequest === request) {
                    taskStatusRequest = null;
                    ${workspace ? 'window.idRechargeWorkspaceLog?.refreshing(false);' : ''}
                    if (activeJobKey === jobKey && !taskCompleted)
                        taskStatusPollTimer = setTimeout(() => pollTaskStatus(jobKey), 5000);
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
        function applyTaskState(data) {
            const status = taskOutcome(data, data.status);
            if (taskCompleted || (status !== 'running' && !Object.hasOwn(openingResults, status))) return;
            const progress = Number.isFinite(data.progress) ? data.progress : taskProgressValue;
            if (Object.hasOwn(data, 'captcha')) updateCaptchaVerification(data.captcha);
            showProgress();
            statusMsg.style.display = 'none';
            if (status === 'running') {
                const needsVerification = activeCaptcha?.stage === 'awaiting_captcha' || activeCaptcha?.status === 'pending';
                const verificationSubmitted = activeCaptcha?.stage === 'captcha_submitted' || activeCaptcha?.status === 'submitted';
                const label = needsVerification ? '等待完成验证' : verificationSubmitted ? '正在确认验证结果' : stageLabel(data.stage);
                setProgress(progress, label);
                ${workspace ? 'window.idRechargeWorkspaceLog?.record(label);' : ''}
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
            ${workspace ? `window.idRechargeWorkspaceLog?.record(result.title + '。' + result.label, result.tone);
            if (renewalUnconfirmed) window.idRechargeWorkspaceLog?.record('自动续订取消状态未确认，请到目标账号账单页核对。', 'review');
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
        <nav class="tab-nav" aria-label="兑换开通功能">
          <button type="button" class="tab-btn active" data-tab="redeem" aria-pressed="true" aria-controls="redeemSection">自助充值</button>
          <button type="button" class="tab-btn" data-tab="query" aria-pressed="false" aria-controls="querySection">兑换码查询</button>
          <button type="button" class="tab-btn" data-tab="guide" aria-pressed="false" aria-controls="workspaceGuide">使用说明</button>
        </nav>
        <div class="workspace-recharge-heading-actions">
          <a class="btn-secondary" href="/subscription" target="_blank" rel="noopener">${workspaceIcon('receipt')}发票助手</a>
        </div>
      </header>
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
        <h3 id="workspace-log-title">运行日志</h3>
        <p id="workspace-log-help">显示本页收到的任务状态，按北京时间记录。任务运行时自动更新；向上滚动可暂停跟随。</p>
        <div class="workspace-log-actions">
          <label class="workspace-log-follow"><input id="workspaceLogFollow" type="checkbox" checked>自动滚动</label>
          <button type="button" id="workspaceLogRefresh" class="btn-secondary" disabled>刷新</button>
        </div>
      </div>
      <div id="workspaceLogViewport" class="workspace-log-viewport" tabindex="0" role="region" aria-label="本次充值运行日志">
        <p id="workspaceLogEmpty" class="workspace-log-empty">暂无运行记录，提交后自动更新。</p>
        <ol id="workspaceLogEntries" class="workspace-log-entries" role="log" aria-label="任务状态记录" aria-live="polite" aria-relevant="additions"></ol>
      </div>
      <div class="workspace-log-footer">
        <span id="workspaceLogStatus" role="status">等待提交</span>
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
    `</div>${workspaceGuide}</main>`
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
                    window.idRechargeWorkspaceLog?.record(data.manualReview
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
      '<div class="table-container">\n                    <table class="admin-action-table card-pool-table">',
      '<div class="card-pool-type-feedback">' +
        '<span id="card_pool_type_status" role="status"></span>' +
        '<button type="button" id="card_pool_type_retry" class="btn btn-secondary" hidden>重试读取类型</button>' +
        '</div>\n                <div class="table-container">\n                    <table class="admin-action-table card-pool-table">'
    );
    source = source.replace('每次任务从「启用」的代理中随机抽取。',
      '自动充值按套餐要求实测并选择同国家的启用代理；无匹配线路时停止。代理池完全为空时才检查服务器直连出口。');
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
    designTokens
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
    readFile(new URL('../../../frontend/design-tokens.css', import.meta.url), 'utf8')
  ]);
  const assets = new Map();
  for (const [path, source, kind] of [
    ['/redeem', redeem, 'redeem'],
    ['/workspace', redeem, 'workspace'],
    ['/admin', admin, 'admin'],
    ['/subscription', subscription, 'subscription']
  ]) {
    const proxyHelp = '一行一条；支持完整代理链接、主机:端口:账号:密码、账号:密码@主机:端口。未带协议默认 SOCKS5；粘贴后自动整理格式，点击保存才入库。';
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
    ['shell.css', designTokens + '\n' + paginationStyles + '\n' + styles, 'css']
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
