// Management UI only. Never receives payment-card data or starts a payment.
let rechargeRoutingView;
let rechargeRoutingLoading;
let rechargeRoutingSaving = false;
let rechargeRoutingChecking = false;
let rechargeProxyCountryEdit;
let rechargeProxyTypeEdit;
const routingPlanLabels = { plus: 'Plus', pro100: 'Pro 100', pro200: 'Pro 200', pro500: 'Pro 500' };

async function rechargeRoutingRequest(path = '', options = {}) {
    const response = await authFetch('/api/admin/recharge-routing' + path, options);
    const data = await response.json();
    if (!response.ok || !data.success)
        throw Object.assign(new Error(data.message || '套餐线路暂不可用'), { status: response.status });
    return data;
}
function renderRechargeRouting() {
    const view = rechargeRoutingView;
    if (!view) return;
    for (const plan of Object.keys(routingPlanLabels)) {
        const select = document.getElementById('route_plan_' + plan);
        if (!select) continue;
        // Preserve unsaved edits during background proxy checks.
        if (select.dataset.version === String(view.version)) continue;
        select.innerHTML = Object.entries(view.regions).map(([code, region]) =>
            '<option value="' + code + '">' + escapeHtml(region.label + '（' + code + '）— ' + region.currency) + '</option>').join('');
        select.value = view.plans[plan];
        select.dataset.version = String(view.version);
    }
    const status = document.getElementById('route_config_status');
    if (status) status.textContent = '配置版本 ' + view.version + '；账单地址沿用美国（US）。';
    const local = view.checks.find(check => check.proxyId === 0);
    const output = document.getElementById('route_local_status');
    if (output) output.textContent = local
        ? (local.status === 'verified' ? '服务器直连：' + local.countryCode : '服务器直连检测失败') + ' · ' + new Date(local.checkedAt).toLocaleString()
        : '服务器直连尚未检测';
    const history = document.getElementById('route_config_history');
    if (history) history.textContent = view.audit.length
        ? '最近修改：' + new Date(view.audit.at(-1).at).toLocaleString() + '；累计 ' + view.auditCount + ' 条配置记录。' : '';
    syncRechargeCheckoutRoute();
    renderRechargeProxyCountries();
}
async function loadRechargeRouting(fresh = false) {
    if (fresh && rechargeRoutingLoading) await rechargeRoutingLoading.catch(() => {});
    if (!rechargeRoutingLoading) rechargeRoutingLoading = rechargeRoutingRequest().then(data => {
        rechargeRoutingView = data; renderRechargeRouting(); return data;
    }).finally(() => { rechargeRoutingLoading = undefined; });
    return rechargeRoutingLoading;
}
async function saveRechargeRouting(button) {
    if (!rechargeRoutingView || rechargeRoutingSaving) return;
    const plans = Object.fromEntries(Object.keys(routingPlanLabels).map(plan =>
        [plan, document.getElementById('route_plan_' + plan).value]));
    const version = rechargeRoutingView.version;
    rechargeRoutingSaving = true; button.disabled = true;
    try {
        rechargeRoutingView = await rechargeRoutingRequest('', { method: 'PUT',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version, plans }) });
        renderRechargeRouting(); showMessage('套餐支付地区已保存，新任务按此选路', 'success');
    } catch (error) { showMessage(error.message, 'error'); }
    finally { rechargeRoutingSaving = false; button.disabled = false; }
}
async function checkRechargeLocal(button) {
    button.disabled = true;
    try { await rechargeRoutingRequest('/check-local', { method: 'POST' }); await loadRechargeRouting(); }
    catch (error) { showMessage(error.message, 'error'); await loadRechargeRouting().catch(() => {}); }
    finally { button.disabled = false; }
}
function syncRechargeCheckoutRoute() {
    const plan = document.getElementById('checkout_plan_type')?.value || 'plus';
    const select = document.getElementById('checkout_region_selector');
    if (select) {
        select.disabled = true;
        if (rechargeRoutingView) {
            select.innerHTML = Object.entries(rechargeRoutingView.regions).map(([code, region]) =>
                '<option value="' + code + '">' + escapeHtml(region.label + '（' + code + '）— ' + region.currency) + '</option>').join('');
            select.value = rechargeRoutingView.plans[plan];
        }
    }
    const country = rechargeRoutingView?.plans[plan];
    const hint = document.getElementById('checkout_region_hint');
    if (hint) hint.textContent = country ? '按套餐自动选路：' + rechargeRoutingView.regions[country].label + ' / ' + rechargeRoutingView.regions[country].currency : '套餐线路配置尚未载入';
}
function proxyCountryLabel(code) {
    const name = rechargeRoutingView?.proxyCountries?.find(country => country.code === code)?.name;
    return name ? name + '（' + code + '）' : code;
}
function proxyCountryOptions() {
    return '<option value="">请选择代理国家</option>' +
        (rechargeRoutingView?.proxyCountries || []).map(({ code, name }) =>
            '<option value="' + escapeHtml(code) + '">' + escapeHtml(name + '（' + code + '）') + '</option>').join('');
}
function renderRechargeProxyCountries() {
    const view = rechargeRoutingView;
    const country = document.getElementById('proxy_add_country');
    const importType = document.getElementById('proxy_add_type');
    const ready = Boolean(view?.proxyCountries?.length);
    const typesReady = Array.isArray(view?.proxyTypes);
    if (importType) importType.disabled = !typesReady;
    if (country && ready && country.dataset.version !== String(view.version)) {
        const selected = country.value;
        country.innerHTML = proxyCountryOptions();
        country.value = selected;
        country.disabled = false;
        country.dataset.version = String(view.version);
    }
    const labels = new Map((view?.proxyLabels || []).map(label => [label.proxyId, label.countryCode]));
    const types = new Map(typesReady ? view.proxyTypes.map(item => [item.proxyId, item.proxyType]) : []);
    const checks = new Map((view?.checks || []).map(check => [check.proxyId, check]));
    for (const item of proxyPoolList) {
        const id = Number(item.id);
        const labelCell = document.getElementById('proxy_country_' + id);
        const exitCell = document.getElementById('proxy_ip_' + id);
        renderRechargeProxyTypeCell(id, types.get(id), typesReady && labels.has(id));
        if (!labelCell || !exitCell) continue;
        const label = labels.get(id);
        const check = checks.get(id);
        const verified = check?.status === 'verified';
        const mismatch = label && verified && label !== check.countryCode;
        const edit = rechargeProxyCountryEdit?.id === id ? rechargeProxyCountryEdit : null;
        const disabled = edit?.saving ? ' disabled' : '';
        const value = label ? proxyCountryLabel(label) : label === null ? '待标注' : '标注待读取';
        const changeButton = ready && labels.has(id)
            ? '<button type="button" class="btn btn-secondary" data-proxy-country-edit="' + id + '">' +
                (label ? '修改标注' : '补标') + '</button>' : '';
        labelCell.innerHTML = '<div class="proxy-country-summary"><span>' + escapeHtml(value) + '</span>' +
            (edit ? '' : changeButton) + '</div>' +
            (mismatch ? '<span class="status-badge status-warning proxy-country-mismatch">国家不一致</span>' : '');
        if (edit) {
            labelCell.insertAdjacentHTML('beforeend', '<div class="proxy-country-editor">' +
                '<select class="asset-input" data-proxy-country-draft required aria-label="代理国家标注"' + disabled + '>' +
                proxyCountryOptions() + '</select>' +
                '<button type="button" class="btn btn-primary" data-proxy-country-save' +
                (edit.saving || !edit.value || edit.conflict ? ' disabled' : '') + '>保存标注</button>' +
                '<button type="button" class="btn btn-secondary" data-proxy-country-cancel' + disabled + '>取消</button>' +
                '<small data-proxy-country-feedback role="status">' + escapeHtml(edit.error || '') + '</small></div>');
            labelCell.querySelector('[data-proxy-country-draft]').value = edit.value;
        }
        const ip = verified ? check.ip : !check && item.last_check_ok ? item.last_check_ip : '';
        const detail = verified ? proxyCountryLabel(check.countryCode)
            : check?.status === 'failed' || item.last_check_ok === false ? '检测失败' : '国家待核验';
        const time = check?.checkedAt || item.last_check_at;
        exitCell.title = time ? '最近检测 ' + new Date(time).toLocaleString('zh-CN', { hour12: false }) : '';
        exitCell.innerHTML = (ip ? '<code>' + escapeHtml(ip) + '</code>' : '') +
            '<small class="proxy-exit-country">' + escapeHtml(detail) + '</small>';
        if (verified || check?.status === 'failed') {
            document.getElementById('proxy_check_' + id).innerHTML = renderProxyCheckBadge({ last_check_ok: verified });
            document.getElementById('proxy_lat_' + id).textContent =
                verified && check.latencyMs != null ? check.latencyMs + 'ms' : '—';
        }
    }
}
function renderRechargeProxyTypeCell(id, value, ready) {
    const cell = document.getElementById('proxy_type_' + id);
    if (!cell) return;
    if (!ready) {
        cell.textContent = '类型待读取';
        return;
    }
    const label = Object.hasOwn(rechargeProxyTypeLabels, value) ? rechargeProxyTypeLabels[value] : '未设置';
    const edit = rechargeProxyTypeEdit?.id === id ? rechargeProxyTypeEdit : null;
    cell.innerHTML = '<div class="proxy-country-summary"><span>' + escapeHtml(label) + '</span>' +
        (edit ? '' : '<button type="button" class="btn btn-secondary" data-proxy-type-edit="' + id + '">' +
            (label === '未设置' ? '设置类型' : '修改类型') + '</button>') + '</div>';
    if (!edit) return;
    const disabled = edit.saving ? ' disabled' : '';
    const options = Object.entries(rechargeProxyTypeLabels).map(([code, name]) =>
        '<option value="' + escapeHtml(code) + '">' + escapeHtml(name) + '</option>').join('');
    cell.insertAdjacentHTML('beforeend', '<div class="proxy-country-editor">' +
        '<select class="asset-input" data-proxy-type-draft required aria-label="已保存代理类型"' + disabled + '>' +
        '<option value="">请选择代理类型</option>' + options + '</select>' +
        '<button type="button" class="btn btn-primary" data-proxy-type-save' +
        (edit.saving || !edit.value || edit.conflict ? ' disabled' : '') + '>保存类型</button>' +
        '<button type="button" class="btn btn-secondary" data-proxy-type-cancel' + disabled + '>取消</button>' +
        '<small role="status">' + escapeHtml(edit.error || '') + '</small></div>');
    cell.querySelector('[data-proxy-type-draft]').value = edit.value;
}
function readRechargeProxyTypeDraft(id) {
    return window.parent.IDRechargeDrafts?.read('admin')?.['proxy-type/' + id] || '';
}
function writeRechargeProxyTypeDraft(id, value) {
    const bridge = window.parent.IDRechargeDrafts;
    if (!bridge) return;
    const draft = bridge.read('admin') || {};
    const key = 'proxy-type/' + id;
    if (value) draft[key] = value;
    else delete draft[key];
    bridge.write('admin', draft);
}
async function saveRechargeProxyType(edit) {
    if (edit.saving || edit.conflict || !Object.hasOwn(rechargeProxyTypeLabels, edit.value)) return;
    const proxyType = edit.value;
    edit.saving = true;
    edit.error = '';
    renderRechargeProxyCountries();
    try {
        const receipt = await rechargeRoutingRequest('/proxies/' + edit.id + '/type', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ proxyType, expectedProxyType: edit.expected })
        });
        if (receipt.proxyId !== edit.id || receipt.proxyType !== proxyType)
            throw new Error('代理类型保存未确认，请刷新列表核对。');
        const types = rechargeRoutingView?.proxyTypes;
        if (Array.isArray(types)) {
            const saved = types.find(item => item.proxyId === edit.id);
            if (saved) saved.proxyType = proxyType;
            else types.push({ proxyId: edit.id, proxyType });
        }
        if (readRechargeProxyTypeDraft(edit.id) === proxyType) writeRechargeProxyTypeDraft(edit.id, '');
        rechargeProxyTypeEdit = undefined;
        renderRechargeProxyCountries();
        showMessage('代理类型已保存', 'success');
        await loadRechargeRouting(true).catch(() => {});
    } catch (error) {
        edit.error = error.message;
        edit.conflict = error.status === 409;
        if (edit.conflict) await loadRechargeRouting(true).catch(() => {});
    } finally {
        edit.saving = false;
        renderRechargeProxyCountries();
        const control = rechargeProxyTypeEdit ? '[data-proxy-type-draft]' : '[data-proxy-type-edit="' + edit.id + '"]';
        document.querySelector(control)?.focus({ preventScroll: true });
    }
}
document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-proxy-type-edit], [data-proxy-type-save], [data-proxy-type-cancel]');
    if (!trigger || rechargeProxyTypeEdit?.saving) return;
    if (trigger.hasAttribute('data-proxy-type-edit')) {
        const id = Number(trigger.dataset.proxyTypeEdit);
        if (!rechargeRoutingView?.proxyLabels?.some(item => item.proxyId === id) ||
            !Array.isArray(rechargeRoutingView.proxyTypes)) return;
        const current = rechargeRoutingView.proxyTypes.find(item => item.proxyId === id)?.proxyType ?? null;
        const draft = readRechargeProxyTypeDraft(id);
        rechargeProxyTypeEdit = { id, expected: current,
            value: Object.hasOwn(rechargeProxyTypeLabels, draft) ? draft : current || '' };
        renderRechargeProxyCountries();
        document.querySelector('[data-proxy-type-draft]')?.focus();
    } else if (trigger.hasAttribute('data-proxy-type-save') && rechargeProxyTypeEdit) {
        void saveRechargeProxyType(rechargeProxyTypeEdit);
    } else if (rechargeProxyTypeEdit) {
        const { id } = rechargeProxyTypeEdit;
        rechargeProxyTypeEdit = undefined;
        renderRechargeProxyCountries();
        document.querySelector('[data-proxy-type-edit="' + id + '"]')?.focus();
    }
});
document.addEventListener('change', event => {
    if (!event.target.matches('[data-proxy-type-draft]') || !rechargeProxyTypeEdit) return;
    const value = event.target.value;
    rechargeProxyTypeEdit.value = value;
    writeRechargeProxyTypeDraft(rechargeProxyTypeEdit.id, value);
    event.target.closest('.proxy-country-editor').querySelector('[data-proxy-type-save]').disabled =
        !value || rechargeProxyTypeEdit.conflict;
});
async function saveRechargeProxyCountry(edit) {
    if (edit.saving || edit.conflict || !edit.value) return;
    edit.saving = true;
    edit.error = '';
    renderRechargeProxyCountries();
    try {
        const receipt = await rechargeRoutingRequest('/proxies/' + edit.id + '/country', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ countryCode: edit.value, expectedCountryCode: edit.expected })
        });
        const label = rechargeRoutingView?.proxyLabels?.find(item => item.proxyId === receipt.proxyId);
        if (label) label.countryCode = receipt.countryCode;
        rechargeProxyCountryEdit = undefined;
        renderRechargeProxyCountries();
        showMessage('代理国家已保存', 'success');
        await loadRechargeRouting(true).catch(() => {});
    } catch (error) {
        edit.error = error.message;
        edit.conflict = error.status === 409;
        if (edit.conflict) await loadRechargeRouting(true).catch(() => {});
    } finally {
        edit.saving = false;
        renderRechargeProxyCountries();
        const control = rechargeProxyCountryEdit ? '[data-proxy-country-draft]' : '[data-proxy-country-edit="' + edit.id + '"]';
        document.querySelector(control)?.focus({ preventScroll: true });
    }
}
document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-proxy-country-edit], [data-proxy-country-save], [data-proxy-country-cancel]');
    if (!trigger || rechargeProxyCountryEdit?.saving) return;
    if (trigger.hasAttribute('data-proxy-country-edit')) {
        const id = Number(trigger.dataset.proxyCountryEdit);
        const label = rechargeRoutingView?.proxyLabels?.find(item => item.proxyId === id);
        if (!label) return;
        rechargeProxyCountryEdit = { id, expected: label.countryCode, value: label.countryCode || '' };
        renderRechargeProxyCountries();
        document.querySelector('[data-proxy-country-draft]')?.focus();
    } else if (trigger.hasAttribute('data-proxy-country-save') && rechargeProxyCountryEdit) {
        void saveRechargeProxyCountry(rechargeProxyCountryEdit);
    } else if (rechargeProxyCountryEdit) {
        const { id } = rechargeProxyCountryEdit;
        rechargeProxyCountryEdit = undefined;
        renderRechargeProxyCountries();
        document.querySelector('[data-proxy-country-edit="' + id + '"]')?.focus();
    }
});
document.addEventListener('change', event => {
    if (!event.target.matches('[data-proxy-country-draft]') || !rechargeProxyCountryEdit) return;
    rechargeProxyCountryEdit.value = event.target.value;
    const editor = event.target.closest('.proxy-country-editor');
    editor.querySelector('[data-proxy-country-save]').disabled = !event.target.value || rechargeProxyCountryEdit.conflict;
});
const originalRoutingLoadRegion = loadRegionConfig;
loadRegionConfig = async function () {
    await originalRoutingLoadRegion();
    try { await loadRechargeRouting(); }
    catch (error) {
        const status = document.getElementById('route_config_status');
        if (status) status.textContent = error.message;
        syncRechargeCheckoutRoute();
    }
};
const originalRoutingLoadProxies = loadProxyPool;
loadProxyPool = async function () {
    await originalRoutingLoadProxies();
    try { await loadRechargeRouting(true); }
    catch (error) {
        const select = document.getElementById('proxy_add_country');
        if (select?.disabled) select.options[0].textContent = '国家选项暂不可用';
        throw error;
    }
};
const originalRoutingRenderProxies = renderProxyPoolTable;
renderProxyPoolTable = function () { originalRoutingRenderProxies(); renderRechargeProxyCountries(); };
const originalRoutingSyncPlan = syncCheckoutPlanName;
syncCheckoutPlanName = function () { originalRoutingSyncPlan(); syncRechargeCheckoutRoute(); };
onCheckoutRegionChange = syncRechargeCheckoutRoute;
loadCheckoutDebugPage = async function () {
    await loadRechargeRouting(); await loadCheckoutPlans(); syncRechargeCheckoutRoute(); lucide.createIcons();
};
const originalRoutingStartDebug = startCheckoutDebug;
let routingDebugSubmitting = false;
startCheckoutDebug = async function () {
    if (routingDebugSubmitting) return;
    routingDebugSubmitting = true;
    try { await loadRechargeRouting(); syncRechargeCheckoutRoute(); await originalRoutingStartDebug(); }
    catch (error) { showMessage(error.message, 'error'); }
    finally { routingDebugSubmitting = false; }
};
function applyRechargeProxyCheck(id, result) {
    applyProxyTestResultToRow(id, result);
    if (!rechargeRoutingView) return;
    const checks = rechargeRoutingView.checks.filter(check => check.proxyId !== Number(id));
    checks.push({ proxyId: Number(id), status: 'verified', ip: result.ip,
        countryCode: result.countryCode, checkedAt: result.checkedAt, latencyMs: result.latencyMs });
    rechargeRoutingView.checks = checks;
}
testSavedProxy = async function (id) {
    if (rechargeRoutingChecking) return;
    rechargeRoutingChecking = true;
    try {
        const data = await rechargeRoutingRequest('/proxies/' + id + '/check', { method: 'POST' });
        applyRechargeProxyCheck(id, data);
        renderRechargeProxyCountries();
        const label = rechargeRoutingView?.proxyLabels?.find(item => item.proxyId === Number(id))?.countryCode;
        const mismatch = label && label !== data.countryCode;
        showMessage((mismatch ? '国家不一致，实测出口：' : '实测出口：') + proxyCountryLabel(data.countryCode),
            mismatch ? 'warning' : 'success');
    } catch (error) { showMessage(error.message, 'error'); }
    finally { rechargeRoutingChecking = false; await loadProxyPool().catch(() => {}); }
};
testAllSavedProxies = async function () {
    if (rechargeRoutingChecking || !proxyPoolList.length) return;
    rechargeRoutingChecking = true;
    let passed = 0;
    try {
        for (const item of [...proxyPoolList]) {
            try {
                const data = await rechargeRoutingRequest('/proxies/' + item.id + '/check', { method: 'POST' });
                applyRechargeProxyCheck(item.id, data);
                passed++;
            }
            catch { /* Each failed check remains visible in the refreshed list. */ }
        }
        renderRechargeProxyCountries();
        showMessage('检测完成：已核验 ' + passed + ' / ' + proxyPoolList.length + ' 条出口', passed ? 'success' : 'warning');
    } finally { rechargeRoutingChecking = false; await loadProxyPool().catch(() => {}); }
};

// Upstream debug renderer references this missing UI helper; use unified auth, never query tokens.
function buildScreenshotUrl(path) {
    return '/api/admin/screenshots?path=' + encodeURIComponent(String(path || ''));
}
