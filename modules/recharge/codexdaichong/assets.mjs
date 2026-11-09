import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { CODEXDAICHONG_REVISION } from './prepare.mjs';
import { workspaceGuide, workspaceIcon } from './workspace-guide.mjs';
import { normalizeRechargeProxyInput } from './proxy-input.mjs';
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

function adaptAdminScript(source, routingScript) {
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

function adaptWorkspaceRecharge(source) {
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
          <span id="flowStatusBadge" class="flow-badge pending">待开始</span>
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
        function setWorkspaceVerified(verified) {
            cdkInput.readOnly = verified;
            redeemBtn.hidden = verified;
            backToStep1.hidden = !verified;
            step2.disabled = !verified;
        }
        function updateConfirmation() {
            const result = validateSessionInput(tokenInput.value, { silent: true });
            account.textContent = result.valid && result.email ? result.email : '填写后显示';
            accountHint.textContent = tokenInput.value.trim() && !result.valid ? result.message : '';
            startBtn.disabled = !verifiedCdk || !result.valid || activationLocked ||
                (taskCompleted && activeJobKey) || pendingReview.has(verifiedCdk);
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
        tokenInput.addEventListener('input', () => {
            updateConfirmation();
        });
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
    '                startBtn.disabled = false;\n                return;',
    `
                if (status === 'manual' || /转人工|人工确认|待核实/.test(message)) {
                    pendingReview.add(verifiedCdk);
                    startBtn.disabled = true;
                } else {
                    taskCompleted = false;
                    activeJobKey = '';
                    updateConfirmation();
                }
                return;
  `
  );
  replace(
    '            const rawSession = tokenInput.value.trim();',
    `
            if (activationLocked || (taskCompleted && activeJobKey) || pendingReview.has(verifiedCdk)) return;
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
                } else if (response.status >= 500 || data.success !== false) {
                    markUncertain();
                } else {
                    if (data.manualReview) pendingReview.add(verifiedCdk);
                    hideProgress();
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
                tokenInput.readOnly = tokenInput.dataset.demoReadonly === 'true';
  `
  );
  replace(
    '<div id="statusMessage" class="status-message">',
    '<div id="statusMessage" class="status-message" role="status">'
  );
  return source;
}

function adaptHtml(source, kind) {
  if (kind === 'redeem' || kind === 'workspace') source = adaptRedeemHtml(source);
  if (kind === 'workspace') source = adaptWorkspaceRecharge(source);
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
    routingScript
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
    readFile(new URL('routing-admin.js', import.meta.url), 'utf8')
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
    ['admin.js', adaptAdminScript(adminJs, routingScript), 'js'],
    ['admin.css', adminCss, 'css'],
    ['style.css', publicCss, 'css'],
    ['favicon.svg', favicon, 'svg'],
    ['lucide.js', lucide, 'js'],
    ['shell.js', shell, 'js'],
    ['shell.css', styles, 'css']
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
