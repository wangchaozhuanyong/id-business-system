// Management UI only. Never receives payment-card data or starts a payment.
let rechargeRoutingView;
let rechargeRoutingLoading;
let rechargeRoutingSaving = false;
let rechargeRoutingChecking = false;
const routingPlanLabels = { plus: 'Plus', pro100: 'Pro 100', pro200: 'Pro 200', pro500: 'Pro 500' };

async function rechargeRoutingRequest(path = '', options = {}) {
    const response = await authFetch('/api/admin/recharge-routing' + path, options);
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || '套餐线路暂不可用');
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
async function loadRechargeRouting() {
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
function renderRechargeProxyCountries() {
    for (const item of proxyPoolList) {
        const cell = document.getElementById('proxy_ip_' + item.id);
        if (!cell) continue;
        cell.querySelector('[data-route-country]')?.remove();
        const check = rechargeRoutingView?.checks.find(check => check.proxyId === Number(item.id));
        const line = document.createElement('small');
        line.dataset.routeCountry = 'true';
        line.textContent = check
            ? (check.status === 'verified' ? '国家：' + (rechargeRoutingView.regions[check.countryCode]?.label || check.countryCode) + '（' + check.countryCode + '）' : '国家检测失败') + ' · ' + new Date(check.checkedAt).toLocaleString()
            : '国家尚未核验，启动前将自动检测';
        cell.append(line);
    }
}
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
    await loadRechargeRouting();
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
testSavedProxy = async function (id) {
    if (rechargeRoutingChecking) return;
    rechargeRoutingChecking = true;
    try {
        const data = await rechargeRoutingRequest('/proxies/' + id + '/check', { method: 'POST' });
        applyProxyTestResultToRow(id, data);
        showMessage('出口国家已核验：' + data.countryCode, 'success');
    } catch (error) { showMessage(error.message, 'error'); }
    finally { rechargeRoutingChecking = false; await loadProxyPool().catch(() => {}); }
};
testAllSavedProxies = async function () {
    if (rechargeRoutingChecking || !proxyPoolList.length) return;
    rechargeRoutingChecking = true;
    let passed = 0;
    try {
        for (const item of [...proxyPoolList]) {
            try { await rechargeRoutingRequest('/proxies/' + item.id + '/check', { method: 'POST' }); passed++; }
            catch { /* Each failed check remains visible in the refreshed list. */ }
        }
        showMessage('检测完成：' + passed + ' / ' + proxyPoolList.length + ' 条可用', passed ? 'success' : 'warning');
    } finally { rechargeRoutingChecking = false; await loadProxyPool().catch(() => {}); }
};

// Upstream debug renderer references this missing UI helper; use unified auth, never query tokens.
function buildScreenshotUrl(path) {
    return '/api/admin/screenshots?path=' + encodeURIComponent(String(path || ''));
}
