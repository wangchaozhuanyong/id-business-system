'use strict';

const axios = require('axios');
const store = require('./mysql-store');
const { getRegionConfig } = require('./region-config');
const { executePaymentWithRetry } = require('./payment-retry');

function buildCheckoutPayload(planName, country, currency) {
    if (!String(planName || '').trim()) throw new Error('缺少已核实的目标套餐标识，未创建付款页');
    const uiMode = String(process.env.CHECKOUT_UI_MODE || 'custom').trim() || 'custom';
    return {
        entry_point: 'all_plans_pricing_modal',
        plan_name: planName,
        billing_details: { country, currency },
        checkout_ui_mode: uiMode
    };
}

function formatApiErrorDetail(detail, fallback = '') {
    if (detail == null || detail === '') return fallback;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
        return detail.map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item))).join('; ');
    }
    if (typeof detail === 'object') {
        if (detail.message) return String(detail.message);
        if (detail.msg) return String(detail.msg);
        return JSON.stringify(detail);
    }
    return String(detail);
}

function parseCheckoutApiResponse(status, bodyText) {
    let data = {};
    try {
        data = bodyText ? JSON.parse(bodyText) : {};
    } catch (_) {
        data = {};
    }

    if (status !== 200) {
        const detail = formatApiErrorDetail(
            data.detail ?? data.message ?? data.error,
            bodyText.slice(0, 500) || `HTTP ${status}`
        );
        return { ok: false, status, data, error: detail };
    }

    const service = new ChatGPTService(null, '');
    const resolved = service.resolveCheckoutUrl(data);
    if (!resolved.checkoutUrl) {
        return {
            ok: false,
            status,
            data,
            error: '官网建单响应缺少可核实的原单编号、处理实体或对应链接，未继续付款',
            errorCode: 'CHECKOUT_RECOVERY_INVALID'
        };
    }

    return { ok: true, status, data, ...resolved };
}

/**
 * 使用 axios 直接调用 Checkout API（供后台调试 / 无 Playwright 场景）
 */
async function createHostedCheckoutLink({ accessToken, planType = 'plus', planName, country, currency }) {
    const token = String(accessToken || '').trim();
    if (!token) {
        return { success: false, error: '缺少 AccessToken' };
    }

    const region = String(country || 'PH').toUpperCase();
    const billingCurrency = String(currency || getRegionConfig(region)?.currency || 'PHP').toUpperCase();
    const planNameResolved = String(planName || store.resolvePlanName(planType)).trim();
    const payload = buildCheckoutPayload(planNameResolved, region, billingCurrency);

    const response = await axios.post(
        'https://chatgpt.com/backend-api/payments/checkout',
        payload,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            validateStatus: () => true,
            timeout: 30000
        }
    );

    const parsed = parseCheckoutApiResponse(response.status, JSON.stringify(response.data ?? {}));
    const base = {
        plan_type: planType,
        plan_name: planNameResolved,
        country: region,
        currency: billingCurrency,
        request: payload,
        response: parsed.data,
        http_status: parsed.status
    };

    if (!parsed.ok) {
        return { success: false, ...base, error: parsed.error };
    }

    return {
        success: true,
        ...base,
        url: parsed.checkoutUrl,
        session_id: parsed.sessionId
    };
}

/**
 * ChatGPT 订阅服务 — Stripe 信用卡直付版本
 *
 * 职责：
 * 1. 根据 plan_type 解析 plan_name（通过 store.resolvePlanName）
 * 2. 创建 Stripe Checkout Session（调用 OpenAI 后端 API）
 * 3. 协调卡池管理、免税地址、Stripe 表单自动化完成支付
 * 4. 委托 payment-retry.js 处理支付重试与卡片轮换逻辑
 * 5. 记录账单信息（成功/失败）
 */
class ChatGPTService {
    /**
     * @param {object} request - Playwright context.request 实例
     * @param {string} token - OpenAI Bearer Token
     */
    constructor(request, token) {
        this.request = request;
        this.token = token;
        this.headers = {
            "Authorization": `Bearer ${this.token}`,
            "Content-Type": "application/json",
            "Accept": "application/json"
        };
    }

    /**
     * 从 checkout API 响应解析支付链接
     * custom 模式：使用官网明确返回的处理实体/编号，或官网完整原单地址中的精确路径
     * hosted 模式：优先使用 API 返回的 url
     */
    resolveCheckoutUrl(data) {
        if (!data || typeof data !== 'object') {
            return { sessionId: null, checkoutUrl: null };
        }

        const idPattern = /^(?:oaics_[A-Za-z0-9_]{1,200}|cs_(?:live|test)_[A-Za-z0-9]{1,200})$/;
        const entityPattern = /^[a-z][a-z0-9_]{0,40}$/;
        const explicitIds = ['checkout_session_id', 'session_id'].filter((key) => Object.hasOwn(data, key)).map((key) => data[key]);
        const hasEntity = Object.hasOwn(data, 'processor_entity');
        if (explicitIds.some((value) => typeof value !== 'string' || !idPattern.test(value)) ||
            new Set(explicitIds).size > 1 ||
            (hasEntity && data.processor_entity !== null && (typeof data.processor_entity !== 'string' || !entityPattern.test(data.processor_entity)))) return { sessionId: null, checkoutUrl: null };
        const sessionId = explicitIds[0] || null;
        const processorEntity = hasEntity ? data.processor_entity : null;
        const sourceFor = (id, entity) => id?.startsWith('cs_') && entity
            ? { kind: 'official_checkout_response', checkoutId: id, processorEntity: entity } : undefined;

        const apiUrl = String(data.url || '').trim();
        if (apiUrl) {
            try {
                const parsed = new URL(apiUrl);
                if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) return { sessionId, checkoutUrl: null };
                if (parsed.hostname === 'chatgpt.com') {
                    const embedded = /^\/checkout\/([a-z][a-z0-9_]{0,40})\/(oaics_[A-Za-z0-9_]{1,200}|cs_(?:live|test)_[A-Za-z0-9]{1,200})\/?$/.exec(parsed.pathname);
                    if (!embedded || (hasEntity && !processorEntity) || (sessionId && embedded[2] !== sessionId) || (processorEntity && embedded[1] !== processorEntity)) return { sessionId, checkoutUrl: null };
                    return { sessionId: embedded[2], processorEntity: embedded[1],
                        checkoutSource: sourceFor(embedded[2], embedded[1]), checkoutUrl: parsed.href };
                } else {
                    if (!['pay.openai.com', 'checkout.stripe.com'].includes(parsed.hostname)) return { sessionId, checkoutUrl: null };
                    const hosted = /^\/c\/pay\/(cs_(?:live|test)_[A-Za-z0-9]{1,200})\/?$/.exec(parsed.pathname);
                    if (!hosted || (sessionId && hosted[1] !== sessionId)) return { sessionId, checkoutUrl: null };
                    return { sessionId: hosted[1], processorEntity: null, checkoutUrl: parsed.href };
                }
            } catch (_) { return { sessionId, checkoutUrl: null }; }
        }

        if (sessionId && processorEntity) {
            return {
                sessionId,
                processorEntity,
                checkoutSource: sourceFor(sessionId, processorEntity),
                checkoutUrl: `https://chatgpt.com/checkout/${processorEntity}/${sessionId}`
            };
        }

        return { sessionId, checkoutUrl: null };
    }

    /**
     * 创建 Stripe Checkout Session，根据 plan_type 选择对应 plan_name
     * @param {string} planType - 'plus' | 'pro_5x' | 'pro_20x'
     * @param {string} country - ISO 3166-1 alpha-2 国家代码
     * @param {string} currency - 币种代码 (USD/SGD/MYR)
     * @param {string} [planNameOverride] - 可选，覆盖默认 plan_name
     * @returns {Promise<{ sessionId: string|null, checkoutUrl: string|null, error?: string }>}
     */
    async createCheckoutSession(planType, country, currency, planNameOverride) {
        let requestSent = false;
        try {
            const planName = String(planNameOverride || store.resolvePlanName(planType)).trim();
            const payload = buildCheckoutPayload(planName, country, currency);
            console.log(`[ChatGPT] 创建 Checkout Session: plan_name=${planName}, country=${country}, currency=${currency}, checkout_ui_mode=${payload.checkout_ui_mode}`);

            requestSent = true;
            const response = await this.request.post("https://chatgpt.com/backend-api/payments/checkout", {
                headers: this.headers,
                data: payload
            });

            const bodyText = await response.text().catch(() => "");
            const parsed = parseCheckoutApiResponse(response.status(), bodyText);

            if (!parsed.ok) {
                const detail = parsed.error;
                console.error(`[-] 订单创建失败 (Status: ${parsed.status})`);
                console.error(`    响应: ${detail}`);
                if (String(detail).includes('not_eligible') || String(detail).includes('Offer not found')) {
                    console.error("❌ [提示] 该账号不符合当前套餐/地区订阅条件");
                } else if (String(detail).includes('permission') || String(detail).includes('already_subscribed')) {
                    console.error("❌ [提示] 该账号可能已订阅或无权重复开通");
                }
                const rejected = [400, 401, 403, 404, 405, 409, 422, 429].includes(parsed.status);
                return { sessionId: null, checkoutUrl: null, error: detail,
                    errorCode: parsed.errorCode || (rejected ? 'CHECKOUT_CREATION_REJECTED' : 'CHECKOUT_CREATION_UNKNOWN'),
                    creationState: rejected ? 'rejected' : 'unknown' };
            }

            console.log(`✅ 订单创建成功 (session: ${parsed.sessionId ? parsed.sessionId.slice(0, 24) + '...' : 'unknown'})`);
            if (parsed.checkoutUrl) {
                console.log(`    支付链接: ${parsed.checkoutUrl.slice(0, 120)}...`);
            }
            return { sessionId: parsed.sessionId, checkoutUrl: parsed.checkoutUrl, checkoutSource: parsed.checkoutSource,
                creationState: 'accepted' };
        } catch (e) {
            console.error("[-] 创建 Checkout Session 异常:", e.message);
            return { sessionId: null, checkoutUrl: null, error: e.message,
                errorCode: requestSent ? 'CHECKOUT_CREATION_UNKNOWN' : 'CHECKOUT_CREATION_NOT_SENT',
                creationState: requestSent ? 'unknown' : 'not_sent' };
        }
    }

    /**
     * @deprecated 请使用 createCheckoutSession 返回的 checkoutUrl
     */
    buildCheckoutUrl(checkoutSessionId) {
        if (!checkoutSessionId) {
            return null;
        }
        return `https://pay.openai.com/c/pay/${checkoutSessionId}`;
    }

    /**
     * 完整的 Stripe 信用卡支付流程
     *
     * 委托 payment-retry.js 处理卡片轮换和重试逻辑：
     * - 从卡池分配卡片（store.reserveCard）
     * - 填写 Stripe 表单（completeStripeCardPayment）
     * - 表单校验失败 → 同卡重试最多 2 次
     * - Stripe 拒绝 → 标记卡片报废，换卡
     * - 连续 3 张卡失败 → 终止，status='payment_failed'
     * - 记录账单（store.createBillingRecord）
     *
     * @param {import('playwright').Page} page - Playwright Page 实例
     * @param {object} options
     * @param {string} options.planType - 'plus' | 'pro_5x' | 'pro_20x'
     * @param {string} [options.cdkCode] - 关联的 CDK 码
     * @param {string} [options.email] - 关联的邮箱
     * @returns {Promise<{ success: boolean, error?: string, status?: string }>}
     */
    async processStripePayment(page, options = {}) {
        const { planType = 'plus', cdkCode = null, email = null } = options;

        console.log(`[ChatGPT] 启动 Stripe 信用卡支付流程 (plan: ${planType})`);

        // 委托 payment-retry.js 处理完整的支付重试逻辑
        // 包含：地区配置获取、免税地址选取、卡池分配、表单填写、重试换卡、账单记录
        const result = await executePaymentWithRetry(page, { planType, cdkCode, email });

        if (result.success) {
            console.log(`✅ [ChatGPT] 支付成功！`);
        } else {
            console.error(`❌ [ChatGPT] 支付失败: ${result.error}`);
        }

        return result;
    }

    /**
     * 根据 plan_type 和 currency 获取预估金额
     * 用于外部调用方查询参考价格
     * @param {string} planType - 'plus' | 'pro_5x' | 'pro_20x'
     * @param {string} currency - 币种代码
     * @returns {number} 预估金额
     */
    getPlanAmount(planType, currency) {
        if (currency === 'CLP') throw new Error('智利价格必须读取官网实际报价，不能从套餐档位推算');
        // 基础美元定价
        const baseAmounts = {
            plus: 20.00,
            pro_5x: 100.00,
            pro_20x: 200.00
        };
        const amount = baseAmounts[planType];
        if (amount == null) throw new Error('未核实该套餐金额，请以官网实际报价为准');

        // 非 USD 币种的简单转换（实际金额由 Stripe 返回，这里仅用于记录参考）
        if (currency === 'SGD') return Math.round(amount * 1.35 * 100) / 100;
        if (currency === 'MYR') return Math.round(amount * 4.50 * 100) / 100;
        if (currency === 'PHP') return Math.round(amount * 56 * 100) / 100;
        return amount;
    }
}

/**
 * 端到端 Stripe 信用卡支付入口函数
 *
 * 用户流程：CDK → GPT session token → 自动支付
 * 此函数封装完整流程：创建 Checkout Session → 导航到 Stripe 页面 → 执行支付（含重试换卡）
 *
 * @param {object} params
 * @param {import('playwright').Page} params.page - Playwright Page 实例
 * @param {string} params.accessToken - OpenAI Bearer Token（用于创建 checkout session）
 * @param {string} params.planType - 'plus' | 'pro_5x' | 'pro_20x'
 * @param {string} [params.cdkCode] - 关联的 CDK 码
 * @param {string} [params.email] - 关联的邮箱
 * @param {function} [params.onProgress] - 进度回调 (message: string) => void
 * @returns {Promise<{ success: boolean, error?: string, sessionId?: string }>}
 */
async function activateSubscription({ page, accessToken, planType, cdkCode, email, onProgress }) {
    const notify = typeof onProgress === 'function' ? onProgress : () => {};

    // Step 1: Resolve billing region and currency
    const region = await store.getPaymentRegion();
    const regionConfig = getRegionConfig(region);
    if (!regionConfig) {
        return { success: false, error: `不支持的支付地区: ${region}` };
    }
    const { currency } = regionConfig;
    const country = region;

    notify(`地区: ${region}, 币种: ${currency}, 套餐: ${planType}`);

    // Step 2: Create Checkout Session via OpenAI API
    notify('正在创建 Stripe Checkout Session...');
    const gpt = new ChatGPTService(page.context().request, accessToken);
    require('../checkout-recovery.cjs').rememberOfficialCheckout(page, null);
    const checkout = await gpt.createCheckoutSession(planType, country, currency);

    if (!checkout.checkoutUrl) {
        return { success: false, error: '无法获取支付链接 (createCheckoutSession 失败)' };
    }

    // Step 3: Navigate to Stripe Checkout URL
    const checkoutUrl = checkout.checkoutUrl;
    require('../checkout-recovery.cjs').rememberOfficialCheckout(page, checkout.checkoutSource);
    notify('正在打开 Stripe Checkout 页面...');

    await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    notify('Checkout 页面已打开，开始信用卡支付...');

    // Step 4: Execute payment with card pool retry logic
    const result = await executePaymentWithRetry(page, { planType, cdkCode, email });

    if (result.success) {
        notify('支付成功！');
        return { success: true, sessionId: checkout.sessionId };
    }

    return { success: false, error: result.error, sessionId: checkout.sessionId };
}

/**
 * 判断 Checkout 页面是否已正常加载（避免 body 里 incidental "404" 误报）
 */
async function assertCheckoutPageReady(page, { requireCardReady = true } = {}) {
    const { isCloudflareWallPage, isCheckoutPaymentReady } = require('./human-verification');
    const currentUrl = page.url();
    const pageText = String(await page.innerText('body', { timeout: 8000 }).catch(() => '') || '');
    const title = String(await page.title().catch(() => '') || '');

    if (await isCloudflareWallPage(page)) {
        throw new Error('Checkout 页面仍被 Cloudflare 人机验证拦截');
    }

    if (/Page not found|could not be found|Something went wrong|contact the merchant/i.test(pageText)) {
        throw new Error(`支付链接无效: ${currentUrl.slice(0, 120)}`);
    }

    if (/accounts\.google\.com|auth\.openai\.com/i.test(currentUrl)) {
        throw new Error(`Checkout 跳转到登录页: ${currentUrl.slice(0, 80)}`);
    }

    if (/^404(\s|$)/.test(title.trim())) {
        throw new Error(`支付链接无效 (404): ${currentUrl.slice(0, 120)}`);
    }

    if (!requireCardReady && ['pay.openai.com', 'checkout.stripe.com'].includes(new URL(currentUrl).hostname)) {
        require('../checkout-recovery.cjs').quoteIdForUrl(currentUrl);
        return currentUrl;
    }
    if (await isCheckoutPaymentReady(page)) return currentUrl;
    throw Object.assign(new Error('无法确认 Checkout 支付表单已加载'), { code: 'CHECKOUT_FORM_NOT_READY' });
}

const CHECKOUT_OPEN_STAGES = new Set(['navigation', 'login', 'readiness', 'final_check']);
const CHECKOUT_OPEN_REASONS = new Set([
    'timeout', 'http_error', 'original_changed', 'session_required',
    'cancelled', 'network_error', 'page_closed', 'not_ready', 'check_failed'
]);
const CHECKOUT_FORM_DIAGNOSTIC_CODES = new Set([
    'CHECKOUT_CARD_NOT_READY', 'CHECKOUT_FORM_NOT_READY', 'CHECKOUT_CONTROL_AMBIGUOUS',
    'CHECKOUT_CONTROL_READ_FAILED', 'CHECKOUT_CONTROL_BLOCKED', 'CHECKOUT_PAGE_CLOSED', 'CHECKOUT_FORM_ABORTED',
    'CHECKOUT_FORM_TIMEOUT', 'CHECKOUT_FORM_DATA_MISSING', 'CHECKOUT_CONTENT_LOAD_FAILED',
    'CHECKOUT_RELOAD_TIMEOUT', 'CHECKOUT_RELOAD_PAYMENT_STARTED', 'CHECKOUT_RELOAD_ALREADY_ATTEMPTED',
    'CHECKOUT_RELOAD_NOT_REQUIRED', 'CHECKOUT_RELOAD_ORIGINAL_CHANGED', 'CHECKOUT_RELOAD_STATE_UNAVAILABLE',
    'CHECKOUT_RELOAD_FAILED', 'CHECKOUT_RELOAD_PAGE_CLOSED', 'CHECKOUT_RELOAD_GUARD_UNAVAILABLE',
    'CHECKOUT_RELOAD_FRAME_WRITE_UNPROVEN'
]);
const CHECKOUT_FORM_DIAGNOSTIC_FIELDS = new Set([
    'number', 'expiry', 'month', 'year', 'cvc', 'name', 'country', 'line1', 'city', 'postal', 'state'
]);
const CHECKOUT_FORM_READ_PHASES = new Set([
    'frame_scan', 'candidate_handles', 'candidate_eligibility', 'value', 'control_read'
]);

function safeCheckoutOpenDiagnostics(value) {
    try {
        if (!value || !CHECKOUT_OPEN_STAGES.has(value.stage) || !CHECKOUT_OPEN_REASONS.has(value.reason)) return undefined;
        const result = {
            stage: value.stage,
            reason: value.reason,
            ...(value.reason === 'http_error' && Number.isInteger(value.httpStatus)
                && value.httpStatus >= 400 && value.httpStatus <= 599 ? { httpStatus: value.httpStatus } : {})
        };
        if (!['readiness', 'final_check'].includes(value.stage)) return result;
        const loading = require('../checkout-recovery.cjs').sanitizeOriginalCheckoutReloadDiagnostics(value.loading);
        if (loading) result.loading = loading;
        if (CHECKOUT_FORM_DIAGNOSTIC_CODES.has(value.code)) result.code = value.code;
        if (Array.isArray(value.missing))
            result.missing = [...new Set(value.missing.slice(0, 64).filter(field => CHECKOUT_FORM_DIAGNOSTIC_FIELDS.has(field)))];
        if (Array.isArray(value.controls) && value.controls.length <= 128) {
            result.controls = value.controls
                .filter(control => control && ['input', 'select', 'textarea', 'other'].includes(control.tag))
                .map(control => ({
                    tag: control.tag,
                    role: control.role === 'combobox' ? 'combobox' : null,
                    fields: Array.isArray(control.fields)
                        ? [...new Set(control.fields.slice(0, 64).filter(field => CHECKOUT_FORM_DIAGNOSTIC_FIELDS.has(field)))] : [],
                    ...(typeof control.required === 'boolean' ? { required: control.required } : {}),
                    ...(typeof control.readOnly === 'boolean' ? { readOnly: control.readOnly } : {})
                }));
            const fields = [...new Set([...(result.missing || []), ...result.controls.flatMap(control => control.fields)])];
            if (fields.length) result.candidateCounts = fields.map(field => ({
                field, count: result.controls.filter(control => control.fields.includes(field)).length
            }));
        }
        if (value.inspection && typeof value.inspection === 'object' && !Array.isArray(value.inspection)) {
            const inspection = {};
            for (const key of ['complete', 'contentLoadFailed', 'timedOut', 'pageClosed', 'aborted'])
                if (typeof value.inspection[key] === 'boolean') inspection[key] = value.inspection[key];
            for (const key of ['framesChecked', 'framesSkipped', 'framesFailed'])
                if (Number.isInteger(value.inspection[key]) && value.inspection[key] >= 0 && value.inspection[key] <= 10000)
                    inspection[key] = value.inspection[key];
            if ([1, 2].includes(value.inspection.readAttempts)) inspection.readAttempts = value.inspection.readAttempts;
            if (CHECKOUT_FORM_READ_PHASES.has(value.inspection.readPhase)) inspection.readPhase = value.inspection.readPhase;
            const visibilityReasons = ['zero_geometry', 'hidden', 'inert', 'aria_hidden', 'display_none',
                'visibility_hidden', 'opacity_zero', 'content_visibility_hidden', 'modal_background'];
            const countGroups = {
                frameSkipCounts: visibilityReasons,
                controlCounts: ['scanned', 'eligible', 'locatable', 'recognized'],
                controlRejectCounts: [...visibilityReasons, 'aria_disabled', 'disabled', 'readonly', 'excluded_type', 'no_locator'],
                interactionRejectCounts: ['occluded', 'outside_viewport', 'unsupported_transform', 'unsupported_geometry',
                    'control_ineligible', 'frame_ineligible', 'scroll_unavailable', 'page_changed']
            };
            for (const [group, keys] of Object.entries(countGroups)) {
                const raw = value.inspection[group];
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
                const clean = {};
                for (const key of keys)
                    if (Object.hasOwn(raw, key) && Number.isInteger(raw[key]) && raw[key] >= 0 && raw[key] <= 10000)
                        clean[key] = raw[key];
                if (Object.keys(clean).length) inspection[group] = clean;
            }
            if (Object.keys(inspection).length) result.inspection = inspection;
        }
        const probe = value.exclusionProbe;
        if (probe && typeof probe === 'object' && !Array.isArray(probe)) {
            const clean = {};
            if (probe.shadowCoverage === 'open_only') clean.shadowCoverage = 'open_only';
            for (const key of ['complete', 'timedOut', 'aborted', 'pageClosed', 'truncated'])
                if (typeof probe[key] === 'boolean') clean[key] = probe[key];
            for (const key of ['framesInspected', 'framesFailed'])
                if (Number.isInteger(probe[key]) && probe[key] >= 0 && probe[key] <= 10000) clean[key] = probe[key];
            const comparison = probe.numberComparison;
            if (comparison && ['semanticEligible', 'geometryEditable'].every(key =>
                Number.isInteger(comparison[key]) && comparison[key] >= 0 && comparison[key] <= 10000))
                clean.numberComparison = { semanticEligible: comparison.semanticEligible,
                    geometryEditable: comparison.geometryEditable };
            const reasons = new Set(['eligible', 'zero_geometry', 'hidden', 'inert', 'aria_hidden',
                'display_none', 'visibility_hidden', 'opacity_zero', 'content_visibility_hidden',
                'modal_background', 'aria_disabled', 'disabled', 'readonly', 'excluded_type']);
            if (Array.isArray(probe.rows)) {
                clean.rows = probe.rows.slice(0, 64).filter(row => row
                    && CHECKOUT_FORM_DIAGNOSTIC_FIELDS.has(row.field) && reasons.has(row.reason)
                    && ['control', 'frame'].includes(row.source) && ['self', 'ancestor', 'computed', 'none'].includes(row.at)
                    && ['main', 'embedded'].includes(row.frameKind) && typeof row.boxVisible === 'boolean'
                    && typeof row.editable === 'boolean' && Number.isInteger(row.count) && row.count >= 1 && row.count <= 10000)
                    .map(row => ({ field: row.field, source: row.source, reason: row.reason, at: row.at,
                        frameKind: row.frameKind, boxVisible: row.boxVisible, editable: row.editable, count: row.count }));
                if (probe.rows.length > 64 || clean.rows.length !== probe.rows.length) {
                    clean.truncated = true;
                    clean.complete = false;
                }
            }
            if (clean.shadowCoverage !== 'open_only' || !clean.numberComparison || !Array.isArray(clean.rows)
                || ['framesInspected', 'framesFailed', 'complete', 'timedOut', 'aborted', 'pageClosed', 'truncated']
                    .some(key => !Object.hasOwn(clean, key))
                || clean.framesFailed > 0 || clean.timedOut || clean.aborted || clean.pageClosed || clean.truncated)
                clean.complete = false;
            if (Object.keys(clean).length) result.exclusionProbe = clean;
        }
        return result;
    } catch (_) {
        // Optional diagnostics cannot replace the original task failure.
        return undefined;
    }
}

function checkoutOpenError(reason, httpStatus) {
    return Object.assign(new Error('原结账页打开检查未完成'), {
        checkoutOpenReason: reason,
        ...(Number.isInteger(httpStatus) ? { httpStatus } : {})
    });
}

function assertOriginalCheckoutPage(page, originalUrl, originalQuoteId, recovery) {
    let current, expected;
    try {
        current = new URL(page.url());
        expected = new URL(originalUrl);
        const quoteId = recovery.quoteIdForUrl(current.href, recovery.officialCheckoutForPage(page));
        if (quoteId === originalQuoteId && current.origin === expected.origin
            && current.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '')) return;
    } catch (_) { /* Identity errors stop this opener; a redirect cannot become a new original. */ }
    throw checkoutOpenError('original_changed');
}

/**
 * 通过 API 注入 billing_details 创建 Checkout，并打开 chatgpt.com/checkout。
 * 文档提交只表示开始加载；原单身份、登录与真实控件仍须在同一期限内核实。
 */
async function openApiCheckout(page, { accessToken, planType, country, currency, planNameOverride, verifyPage = true }) {
    const { assertChatGptLoggedIn } = require('./session-auth');
    const token = String(accessToken || '').trim();
    if (!token) {
        throw new Error('缺少 AccessToken，无法调用 Checkout API');
    }

    const region = String(country || 'PH').toUpperCase();
    const billingCurrency = String(currency || getRegionConfig(region)?.currency || 'PHP').toUpperCase();
    console.log(`🧭 [步骤] 正在通过 API 创建 Checkout (country=${region}, currency=${billingCurrency}, plan=${planType})...`);

    const gpt = new ChatGPTService(page.context().request, token);
    const recovery = require('../checkout-recovery.cjs');
    recovery.rememberOfficialCheckout(page, null);
    const checkout = await gpt.createCheckoutSession(planType, region, billingCurrency, planNameOverride);
    if (!checkout.checkoutUrl) {
        throw Object.assign(new Error('API 创建 Checkout 失败，未取得可核实的原单来源'),
            { code: checkout.errorCode || 'CHECKOUT_CREATION_UNKNOWN', checkoutCreationState: checkout.creationState || 'unknown' });
    }

    let budget;
    let stage = 'navigation';
    try {
        const url = checkout.checkoutUrl;
        recovery.rememberOfficialCheckout(page, checkout.checkoutSource);
        console.log('🔗 [步骤] 正在打开已创建的原结账单...');

        if (!verifyPage) {
            console.log('✅ [步骤] Checkout Session 已创建（跳过页面打开验证）');
            return { checkoutUrl: url, sessionId: checkout.sessionId };
        }

        const ownerSignal = require('../rpc.cjs').taskSignal();
        const { createVerificationBudget } = require('./verification-runtime');
        budget = createVerificationBudget({
            maxWaitMs: Number(process.env.CAPTCHA_CLEAR_TIMEOUT_MS || 120000),
            signal: ownerSignal
        });
        const run = (operation) => { budget.assert(); return budget.run(operation()); };
        const originalQuoteId = recovery.quoteIdForUrl(url, recovery.officialCheckoutForPage(page));
        const response = await run(() => page.goto(url, { waitUntil: 'commit', timeout: budget.timeout(90000) }));
        if (!response || typeof response.status !== 'function') throw checkoutOpenError('check_failed');
        const status = response.status();
        if (!Number.isInteger(status) || status < 200 || status >= 400)
            throw checkoutOpenError(status >= 400 && status <= 599 ? 'http_error' : 'check_failed', status);
        budget.assert();
        assertOriginalCheckoutPage(page, url, originalQuoteId, recovery);

        stage = 'login';
        const { hasVisibleLoginChrome, isCheckoutLoginGate, buildSessionNotLoggedInError } = require('./auth-page-detect');
        if (await run(() => isCheckoutLoginGate(page)) || await run(() => hasVisibleLoginChrome(page)))
            throw checkoutOpenError('session_required');

        stage = 'readiness';
        const { clearHumanVerification, buildCaptchaRequiredError } = require('./human-verification');
        // Hosted Checkout can require selecting Card before it creates card fields.
        // Detect load errors now; stripe-payment performs strict readiness after selection.
        const hostedCheckout = ['pay.openai.com', 'checkout.stripe.com'].includes(new URL(page.url()).hostname);
        const captchaResult = await run(() => clearHumanVerification(page, {
            phase: 'checkout-open',
            maxWaitMs: budget.remaining(),
            deadlineAt: budget.deadlineAt,
            signal: ownerSignal,
            maxBypassRounds: 6,
            requireCheckoutReady: !hostedCheckout,
            prepareCheckout: (preparation) => require('./stripe-payment').prepareCheckoutCardSection(page, preparation),
            checkCheckoutLoad: true,
            allowCheckoutReload: true,
            isSubmitted: () => require('../rpc.cjs').wasSubmitted(),
            checkoutReadyWaitMs: Math.min(budget.remaining(), Number(process.env.CHECKOUT_READY_WAIT_MS || 60000))
        }));
        if (!captchaResult.cleared) {
            let exclusionProbe;
            if (captchaResult.checkoutNotReady && budget.remaining() > 0 && !page.isClosed?.()) {
                try {
                    exclusionProbe = await require('../checkout-form.cjs').inspectCardExclusions(page, {
                        deadline: Date.now() + Math.min(2000, budget.remaining()), signal: budget.signal
                    });
                } catch (_) { /* Optional metadata cannot replace the original readiness failure. */ }
            }
            const err = captchaResult.sessionRequired
                ? (captchaResult.message || buildSessionNotLoggedInError('Checkout 支付页'))
                : captchaResult.checkoutNotReady
                    ? 'Checkout 支付表单未能加载，请检查网络或稍后重试'
                    : buildCaptchaRequiredError();
            const checkoutOpenReason = captchaResult.code === 'VERIFICATION_TIMEOUT' || /_TIMEOUT$/.test(captchaResult.code || '') ? 'timeout'
                    : ['VERIFICATION_CANCELLED', 'CHECKOUT_FORM_ABORTED'].includes(captchaResult.code) ? 'cancelled'
                        : ['VERIFICATION_PAGE_CLOSED', 'CHECKOUT_PAGE_CLOSED'].includes(captchaResult.code) ? 'page_closed'
                            : captchaResult.sessionRequired ? 'session_required'
                                : captchaResult.checkoutNotReady ? 'not_ready' : 'check_failed';
            throw Object.assign(new Error(err), {
                code: captchaResult.code,
                checkoutOpenReason,
                checkoutOpenDiagnostics: safeCheckoutOpenDiagnostics({
                    stage, reason: checkoutOpenReason, code: captchaResult.code,
                    missing: captchaResult.missing, controls: captchaResult.controls,
                    inspection: captchaResult.inspection, exclusionProbe
                })
            });
        }

        stage = 'final_check';
        const currentUrl = await run(() => assertCheckoutPageReady(page, { requireCardReady: !hostedCheckout }));
        await run(() => assertChatGptLoggedIn(page, 'Checkout'));
        budget.assert();
        assertOriginalCheckoutPage(page, url, originalQuoteId, recovery);
        console.log('✅ [步骤] 原结账单的页面和付款控件检查已完成');
        return { checkoutUrl: currentUrl, sessionId: checkout.sessionId };
    } catch (error) {
        const openingInterrupted = budget?.signal.aborted || error.name === 'TimeoutError'
            || ['LEASE_LOST', 'VERIFICATION_TIMEOUT', 'VERIFICATION_CANCELLED', 'CHECKOUT_FORM_ABORTED'].includes(error.code)
            || ['timeout', 'cancelled'].includes(error.checkoutOpenReason);
        if (openingInterrupted && !page.isClosed?.()) {
            // Racing a promise does not cancel Chromium's native navigation. Close
            // only this task page before the caller can release a late response.
            try { await page.close({ runBeforeUnload: false }); } catch (_) { /* Check the actual target state below. */ }
            if (!page.isClosed?.()) {
                error.checkoutOpenCleanupFailed = true;
                console.error('[Checkout] 本任务结账页关闭未确认，须完成任务上下文清理');
            }
        }
        if (error.code === 'LEASE_LOST') throw Object.assign(error, { checkoutCreationState: 'accepted' });
        const loadingFailure = /^CHECKOUT_(?:RELOAD_|CONTENT_LOAD_FAILED|FORM_|CONTROL_|CARD_|PAGE_CLOSED)/.test(error.code || '');
        const code = loadingFailure || ['CHECKOUT_RECOVERY_INVALID', 'CHECKOUT_RECOVERY_UNSUPPORTED'].includes(error.code)
            ? error.code : 'CHECKOUT_OPEN_FAILED';
        const reason = error.checkoutOpenReason
            || (error.name === 'TimeoutError' || error.code === 'VERIFICATION_TIMEOUT' ? 'timeout'
                : error.code === 'VERIFICATION_CANCELLED' ? 'cancelled'
                    : page.isClosed?.() ? 'page_closed'
                        : stage === 'navigation' ? 'network_error' : 'check_failed');
        const checkoutOpenDiagnostics = safeCheckoutOpenDiagnostics({
            ...safeCheckoutOpenDiagnostics(error.checkoutOpenDiagnostics),
            loading: require('../checkout-recovery.cjs').originalCheckoutReloadDiagnostics(page),
            stage, reason, code: error.code, httpStatus: error.httpStatus
        });
        const reasons = {
            timeout: '原结账页打开检查超时',
            http_error: '官网结账页返回 HTTP 错误',
            original_changed: '结账页已离开原单',
            session_required: '原结账页需要重新登录',
            cancelled: '原结账页打开检查已取消',
            network_error: '原结账页导航网络请求未完成',
            page_closed: '原结账页已关闭',
            not_ready: '原结账页的付款控件尚未加载',
            check_failed: '原结账页打开或验证未完成'
        };
        throw Object.assign(new Error(`${reasons[reason] || reasons.check_failed}；未另建结账单`),
            { code, checkoutCreationState: 'accepted', checkoutOpenDiagnostics,
                ...(error.checkoutOpenCleanupFailed ? { checkoutOpenCleanupFailed: true } : {}) });
    } finally {
        budget?.dispose();
    }
}

module.exports = ChatGPTService;
module.exports.ChatGPTService = ChatGPTService;
module.exports.activateSubscription = activateSubscription;
module.exports.openApiCheckout = openApiCheckout;
module.exports.createHostedCheckoutLink = createHostedCheckoutLink;
module.exports.buildCheckoutPayload = buildCheckoutPayload;
module.exports.formatApiErrorDetail = formatApiErrorDetail;

module.exports.safeCheckoutOpenDiagnostics = safeCheckoutOpenDiagnostics;
