'use strict';

const { request: playwrightRequest } = require('playwright');
const { extractProfileFromToken } = require('./session-auth');
const { preparePlaywrightProxy } = require('./playwright-proxy');

const CHECK_V4_BASE = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27';
const CANCEL_SUBSCRIPTION_URL = 'https://chatgpt.com/backend-api/subscriptions/cancel';
const RESUME_SUBSCRIPTION_URL = 'https://chatgpt.com/backend-api/subscriptions/resume';
const BILLING_PAGE_URL = 'https://chatgpt.com/account/manage';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const PLAN_LABELS = {
    plus: 'ChatGPT Plus',
    pro: 'ChatGPT Pro',
    team: 'ChatGPT Team',
    free: '免费版',
    unknown: '未知'
};

const ORIGIN_LABELS = {
    chatgpt_not_purchased: '未购买',
    chatgpt_web: 'Web (Stripe)',
    web: 'Web (Stripe)',
    stripe: 'Stripe',
    ios: 'Apple App Store',
    apple: 'Apple App Store',
    android: 'Google Play',
    google_play: 'Google Play'
};

function normalizeSubscriptionPlan(subPlan, hasActive) {
    const raw = String(subPlan || '').trim().toLowerCase();
    if (!raw) {
        return hasActive ? 'unknown' : 'free';
    }
    if (raw.includes('team')) {
        return 'team';
    }
    if (raw.includes('pro') && !raw.includes('plus')) {
        return 'pro';
    }
    if (raw.includes('plus')) {
        return 'plus';
    }
    if (raw.includes('free')) {
        return 'free';
    }
    return raw.slice(0, 40);
}

function formatPlanLabel(planKey, rawPlan) {
    if (PLAN_LABELS[planKey]) {
        return PLAN_LABELS[planKey];
    }
    if (rawPlan) {
        return rawPlan;
    }
    return PLAN_LABELS.unknown;
}

function formatPurchaseOrigin(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) {
        return '—';
    }
    if (ORIGIN_LABELS[raw]) {
        return ORIGIN_LABELS[raw];
    }
    if (raw.includes('apple') || raw.includes('ios')) {
        return ORIGIN_LABELS.ios;
    }
    if (raw.includes('android') || raw.includes('google')) {
        return ORIGIN_LABELS.android;
    }
    if (raw.includes('stripe') || raw.includes('web')) {
        return ORIGIN_LABELS.chatgpt_web;
    }
    return value;
}

function pickCurrency(...sources) {
    for (const source of sources) {
        if (!source || typeof source !== 'object') {
            continue;
        }
        for (const key of ['billing_currency', 'currency', 'currency_code', 'billing_currency_code']) {
            const value = String(source[key] || '').trim().toUpperCase();
            if (/^[A-Z]{3}$/.test(value)) {
                return value;
            }
        }
    }
    return '';
}

function computeRemainingDays(expiresAt) {
    if (!expiresAt) {
        return null;
    }
    const expiresMs = Date.parse(String(expiresAt));
    if (!Number.isFinite(expiresMs)) {
        return null;
    }
    const diffMs = expiresMs - Date.now();
    return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

function formatDateTime(value) {
    if (!value) {
        return '—';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return String(value);
    }
    return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
}

function formatRemainingDays(days) {
    if (days == null) {
        return '—';
    }
    if (days < 0) {
        return `已过期 ${Math.abs(days)} 天`;
    }
    if (days === 0) {
        return '今天到期';
    }
    return `${days} 天`;
}

function formatBoolean(value) {
    if (value === true) {
        return '是';
    }
    if (value === false) {
        return '否';
    }
    return '—';
}

function buildCheckHeaders(accessToken) {
    return {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
        'User-Agent': USER_AGENT,
        Referer: 'https://chatgpt.com/',
        Origin: 'https://chatgpt.com',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'sec-ch-ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"'
    };
}

function decodeJwtPart(part) {
    const normalized = String(part || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

function validateSessionTokenForQuery(token) {
    const value = String(token || '').trim();
    if (!value) {
        return { valid: false, message: '缺少 AccessToken' };
    }

    const parts = value.split('.');
    if (parts.length !== 3 || parts.some((item) => !item)) {
        return { valid: false, message: '该 Token 不合法：格式错误' };
    }

    let payload;
    try {
        payload = decodeJwtPart(parts[1]);
    } catch (_) {
        return { valid: false, message: '该 Token 不合法：无法解析' };
    }

    if (payload.iss && payload.iss !== 'https://auth.openai.com') {
        return { valid: false, message: '该 Token 不合法：签发方错误' };
    }

    const authInfo = payload['https://api.openai.com/auth'] || {};
    const profile = payload['https://api.openai.com/profile'] || {};
    const exp = Number(payload.exp || 0);
    const now = Math.floor(Date.now() / 1000);
    if (exp && Number.isFinite(exp) && exp <= now) {
        return { valid: false, message: '该 Token 已过期，请重新获取 Session' };
    }

    return {
        valid: true,
        email: profile.email || '',
        accountId: authInfo.chatgpt_account_id || ''
    };
}

function parseAccountCheckResponse(data, profile = {}) {
    const defaultAccount = (data?.accounts || {}).default || {};
    const account = defaultAccount.account || {};
    const entitlement = defaultAccount.entitlement || {};
    const lastActive = defaultAccount.last_active_subscription || {};

    const hasActive = typeof entitlement.has_active_subscription === 'boolean'
        ? entitlement.has_active_subscription : null;
    const rawPlan = String(entitlement.subscription_plan || '');
    const canonicalPlan = require('../plans.cjs').observedCanonicalPlan(rawPlan);
    const planKey = normalizeSubscriptionPlan(rawPlan, hasActive);
    const expiresAt = entitlement.expires_at || lastActive.expires_at || null;
    const remainingDays = computeRemainingDays(expiresAt);
    const currency = pickCurrency(lastActive, entitlement, account) || '—';

    return {
        email: profile.email || '',
        accountId: account.account_id || profile.accountId || '',
        upstreamAccountId: account.account_id || '',
        plan: canonicalPlan ? require('../plans.cjs').PLANS[canonicalPlan].label : formatPlanLabel(planKey, rawPlan),
        planKey,
        rawPlan,
        canonicalPlan,
        tierVerified: Boolean(canonicalPlan),
        hasActiveSubscription: hasActive,
        subscriptionChannel: formatPurchaseOrigin(lastActive.purchase_origin_platform),
        subscriptionChannelRaw: lastActive.purchase_origin_platform || '',
        currency,
        expiresAt: expiresAt || null,
        expiresAtDisplay: formatDateTime(expiresAt),
        remainingDays,
        remainingDaysDisplay: formatRemainingDays(remainingDays),
        autoRenew: formatBoolean(lastActive.will_renew),
        autoRenewRaw: lastActive.will_renew,
        hasPreviouslyPaid: formatBoolean(account.has_previously_paid_subscription),
        hasPreviouslyPaidRaw: Boolean(account.has_previously_paid_subscription),
        queriedAt: new Date().toISOString(),
        queriedAtDisplay: formatDateTime(new Date()),
        billingPageUrl: BILLING_PAGE_URL
    };
}

function buildCheckUrl(timezoneOffsetMin = 0) {
    const offset = Number.isFinite(Number(timezoneOffsetMin))
        ? Number(timezoneOffsetMin)
        : -new Date().getTimezoneOffset();
    return `${CHECK_V4_BASE}?timezone_offset_min=${offset}`;
}

function normalizeResponseBody(data) {
    if (typeof data === 'string') {
        const trimmed = data.trim();
        if (!trimmed) {
            return null;
        }
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                return JSON.parse(trimmed);
            } catch (_) {
                return trimmed;
            }
        }
        return trimmed;
    }
    return data;
}

function isCloudflareBlock(status, data) {
    if (status !== 403) {
        return false;
    }
    const text = typeof data === 'string' ? data : JSON.stringify(data || '');
    return /cloudflare|cf-ray|attention required|just a moment|cf_chl/i.test(text);
}

async function fetchAccountCheckWithPlaywright(accessToken, timezoneOffsetMin = 0, browserContext = null) {
    let cleanup = async () => {}, ctx = browserContext?.request;
    const owned = !ctx;
    try {
      if (owned) {
        const prepared = await preparePlaywrightProxy(String(process.env.PROXY || '').trim());
        cleanup = prepared.cleanup;
        ctx = await playwrightRequest.newContext({ userAgent: USER_AGENT,
            proxy: prepared.proxyConfig || undefined, extraHTTPHeaders: buildCheckHeaders(accessToken) });
      }
        const response = await ctx.get(buildCheckUrl(timezoneOffsetMin), {
            timeout: 20000, headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
        });
        const status = response.status();
        let data;
        try { data = await response.json(); } catch (_) { data = await response.text().catch(() => ''); }
        return { status, data, via: owned ? 'proxy-request' : 'browser-context' };
    } finally {
        if (owned && ctx) await ctx.dispose().catch(() => {});
        await cleanup().catch(() => {});
    }
}

async function fetchAccountCheckInBrowser(accessToken, timezoneOffsetMin, sessionRaw) {
    const runtime = require('./browser-runtime');
    const sessionAuth = require('./session-auth');
    const prepared = await preparePlaywrightProxy(String(process.env.PROXY || '').trim());
    let session, context;
    try {
        session = await runtime.connectTaskBrowser({ proxyConfig: prepared.proxyConfig, headful: process.env.HEADFUL === '1' });
        context = await session.browser.newContext({ proxy: prepared.proxyConfig || undefined,
            userAgent: session.realUserAgent, locale: 'en-US' });
        const installed = await sessionAuth.installChatGptSession(context, sessionRaw);
        const page = await context.newPage();
        const login = await sessionAuth.bootstrapChatGptSession(page, sessionRaw, {
            sessionData: installed?.sessionData || installed, cookieVerified: installed?.cookieVerified === true,
            manualVerification: true
        });
        return await fetchAccountCheckWithPlaywright(login.session?.accessToken || accessToken, timezoneOffsetMin, context);
    } finally {
        if (context) await context.close().catch(() => {});
        if (session) await runtime.closeTaskBrowser(session, session.browser);
        await prepared.cleanup().catch(() => {});
    }
}

async function fetchAccountCheck(accessToken, options = {}) {
    try {
        const result = await fetchAccountCheckWithPlaywright(accessToken, options.timezoneOffsetMin, options.browserContext);
        if (result.status === 403 && !options.browserContext && options.sessionRaw && options.allowBrowserFallback === true)
            return await fetchAccountCheckInBrowser(accessToken, options.timezoneOffsetMin, options.sessionRaw);
        return result;
    } catch (error) {
        if (error.code === 'LEASE_LOST') throw error;
        const code = error.code === 'HUMAN_VERIFICATION_REQUIRED' ? 'HUMAN_VERIFICATION_REQUIRED'
            : /timeout|timed out/i.test(error.message) ? 'NETWORK_TIMEOUT'
                : /proxy|tunnel|socks|ECONNREFUSED/i.test(error.message) ? 'PROXY_UNAVAILABLE'
                    : /Session|尚未登录|未登录/.test(error.message) ? 'SESSION_INVALID' : 'NETWORK_UNAVAILABLE';
        return { status: 0, errorCode: code, data: null };
    }
}

async function requestOpenAiJson(accessToken, { method = 'GET', url, body = null }) {
    const headers = buildCheckHeaders(accessToken);
    const proxyValue = String(process.env.PROXY || '').trim();
    let lastError = null;

    try {
        const { proxyConfig, cleanup } = await preparePlaywrightProxy(proxyValue);
        const ctx = await playwrightRequest.newContext({
            userAgent: USER_AGENT,
            proxy: proxyConfig || undefined,
            extraHTTPHeaders: headers
        });
        try {
            if (method !== 'GET') await require('../rpc.cjs').beforeExternalSubmit({
                provider: 'local',
                stage: 'renewal_update',
                renewalAction: url === RESUME_SUBSCRIPTION_URL ? 'enable' : 'disable'
            });
            const response = await ctx.fetch(url, {
                method,
                timeout: 20000,
                headers: body != null ? { ...headers, 'Content-Type': 'application/json' } : headers,
                data: body != null ? body : undefined
            });
            const status = response.status();
            // A successful POST response is not the final subscription state. Clear the
            // in-flight marker only after a matching account readback, or an auth rejection.
            if (method !== 'GET' && [401, 403].includes(status)) require('../rpc.cjs').recordKnownOutcome();
            let data;
            try {
                data = await response.json();
            } catch (_) {
                data = await response.text().catch(() => '');
            }
            if (status >= 200 && status < 300 || status === 401) {
                return { status, data, via: 'playwright' };
            }
            lastError = { status, data, via: 'playwright' };
        } finally {
            await ctx.dispose().catch(() => {});
            await cleanup().catch(() => {});
        }
    } catch (error) {
        lastError = { status: 0, data: error.message, via: 'playwright', error };
    }

    return lastError || { status: 0, data: 'result_unknown', via: 'playwright' };
}

function isAppStoreOrigin(channelRaw) {
    const raw = String(channelRaw || '').trim().toLowerCase();
    return raw.includes('apple')
        || raw.includes('ios')
        || raw.includes('google')
        || raw.includes('android');
}

async function verifyRenewalUpdate(accessToken, options, subscription, accountId, enabled) {
    const verify = await querySubscriptionBySession(accessToken, {
        timezoneOffsetMin: options.timezoneOffsetMin,
        email: options.email || subscription.email || ''
    });
    if (!verify.ok
        || verify.data.accountId !== accountId
        || verify.data.upstreamAccountId !== accountId
        || verify.data.autoRenewRaw !== enabled) {
        return {
            ok: false,
            resultUnknown: true,
            statusCode: 502,
            error: '续费变更已提交，但同一账号的目标状态尚未确认，请核对原任务，禁止重复提交'
        };
    }
    require('../rpc.cjs').recordKnownOutcome();
    return {
        ok: true,
        data: {
            ...verify.data,
            ...(enabled ? { alreadyEnabled: false, resumed: true } : { alreadyCancelled: false, cancelled: true }),
            message: enabled ? '已成功开启自动续费' : '已成功关闭自动续费，当前周期仍可继续使用'
        }
    };
}

async function cancelAutoRenew(accessToken, options = {}) {
    const token = String(accessToken || '').trim();
    if (!token) {
        return { ok: false, statusCode: 400, error: '缺少 AccessToken' };
    }

    const profile = extractProfileFromToken(token);
    const accountId = String(options.accountId || profile.accountId || '').trim();
    if (!accountId) {
        return { ok: false, statusCode: 400, error: '无法解析 account_id，请确认 Session 完整有效' };
    }

    const checkResult = await querySubscriptionBySession(token, {
        timezoneOffsetMin: options.timezoneOffsetMin,
        email: options.email || profile.email || ''
    });
    if (!checkResult.ok) {
        return checkResult;
    }

    const subscription = checkResult.data;
    if (subscription.accountId !== accountId || subscription.upstreamAccountId !== accountId) {
        return { ok: false, statusCode: 409, error: '订阅账号与当前会话不一致，未提交续费变更' };
    }
    if (isAppStoreOrigin(subscription.subscriptionChannelRaw)) {
        return {
            ok: false,
            statusCode: 400,
            error: `该订阅来自 ${subscription.subscriptionChannel}，无法通过 API 取消，请在对应平台关闭续费`
        };
    }

    if (!subscription.hasActiveSubscription) {
        return { ok: false, statusCode: 400, error: '账号当前无有效订阅，无需取消自动续费' };
    }

    if (subscription.autoRenewRaw === false) {
        return {
            ok: true,
            data: {
                ...subscription,
                alreadyCancelled: true,
                message: '自动续费已关闭，无需重复操作'
            }
        };
    }

    let response;
    try {
        response = await requestOpenAiJson(token, {
            method: 'POST',
            url: CANCEL_SUBSCRIPTION_URL,
            body: { account_id: accountId }
        });
    } catch (error) {
        return {
            ok: false,
            statusCode: 502,
            error: `取消自动续费请求失败：${error.message}`
        };
    }

    const body = normalizeResponseBody(response.data);
    if (response.status === 401) {
        return { ok: false, statusCode: 401, definitiveFailure: true, renewalRejected: true, error: 'Session 无效或已过期，请重新获取 Session' };
    }
    if (response.status === 403) {
        const mapped = mapCheckError(403, body);
        return { ok: false, ...mapped, definitiveFailure: true, renewalRejected: true };
    }
    if (response.status !== 200 && response.status !== 204) {
        const detail = typeof body === 'string'
            ? body.slice(0, 200)
            : JSON.stringify(body || {}).slice(0, 200);
        return {
            ok: false,
            resultUnknown: require('../rpc.cjs').wasSubmitted(),
            statusCode: response.status || 502,
            error: `取消自动续费失败 (${response.status})${detail ? `：${detail}` : ''}`
        };
    }

    return verifyRenewalUpdate(token, options, subscription, accountId, false);
}

async function resumeAutoRenew(accessToken, options = {}) {
    const token = String(accessToken || '').trim();
    if (!token) {
        return { ok: false, statusCode: 400, error: '缺少 AccessToken' };
    }

    const profile = extractProfileFromToken(token);
    const accountId = String(options.accountId || profile.accountId || '').trim();
    if (!accountId) {
        return { ok: false, statusCode: 400, error: '无法解析 account_id，请确认 Session 完整有效' };
    }

    const checkResult = await querySubscriptionBySession(token, {
        timezoneOffsetMin: options.timezoneOffsetMin,
        email: options.email || profile.email || ''
    });
    if (!checkResult.ok) {
        return checkResult;
    }

    const subscription = checkResult.data;
    if (subscription.accountId !== accountId || subscription.upstreamAccountId !== accountId) {
        return { ok: false, statusCode: 409, error: '订阅账号与当前会话不一致，未提交续费变更' };
    }
    if (isAppStoreOrigin(subscription.subscriptionChannelRaw)) {
        return {
            ok: false,
            statusCode: 400,
            error: `该订阅来自 ${subscription.subscriptionChannel}，无法通过 API 开启，请在对应平台操作`
        };
    }

    if (!subscription.hasActiveSubscription) {
        return { ok: false, statusCode: 400, error: '账号当前无有效订阅，无法开启自动续费' };
    }

    if (subscription.autoRenewRaw === true) {
        return {
            ok: true,
            data: {
                ...subscription,
                alreadyEnabled: true,
                message: '自动续费已开启，无需重复操作'
            }
        };
    }

    let response;
    try {
        response = await requestOpenAiJson(token, {
            method: 'POST',
            url: RESUME_SUBSCRIPTION_URL,
            body: { account_id: accountId }
        });
    } catch (error) {
        return {
            ok: false,
            statusCode: 502,
            error: `开启自动续费请求失败：${error.message}`
        };
    }

    const body = normalizeResponseBody(response.data);
    if (response.status === 401) {
        return { ok: false, statusCode: 401, definitiveFailure: true, renewalRejected: true, error: 'Session 无效或已过期，请重新获取 Session' };
    }
    if (response.status === 403) {
        const mapped = mapCheckError(403, body);
        return { ok: false, ...mapped, definitiveFailure: true, renewalRejected: true };
    }
    if (response.status !== 200 && response.status !== 204) {
        const detail = typeof body === 'string'
            ? body.slice(0, 200)
            : JSON.stringify(body || {}).slice(0, 200);
        return {
            ok: false,
            resultUnknown: require('../rpc.cjs').wasSubmitted(),
            statusCode: response.status || 502,
            error: `开启自动续费失败 (${response.status})${detail ? `：${detail}` : ''}`
        };
    }

    return verifyRenewalUpdate(token, options, subscription, accountId, true);
}

function mapCheckError(status, data) {
    const body = normalizeResponseBody(data);

    if (status === 401) {
        return { statusCode: 401, errorCode: 'SESSION_INVALID', error: 'Session 无效或已过期，请重新获取 Session' };
    }

    if (status === 403) {
        if (isCloudflareBlock(status, body)) {
            return {
                statusCode: 403,
                errorCode: 'UPSTREAM_BLOCKED', error: '官网风控拦截，订阅状态未能核实，请检查任务代理或人工验证'
            };
        }
        return {
            statusCode: 403,
            errorCode: 'UPSTREAM_FORBIDDEN', error: '官网拒绝此次查询（403），不能据此确定登录资料已过期'
        };
    }

    if (!status) {
        return { statusCode: 502, error: `无法连接 OpenAI 订阅接口：${String(body || 'network error')}` };
    }

    const detail = typeof body === 'string'
        ? body.slice(0, 200)
        : JSON.stringify(body || {}).slice(0, 200);
    return {
        statusCode: status || 502,
        error: `OpenAI 返回异常 (${status})${detail ? `：${detail}` : ''}`
    };
}

async function querySubscriptionBySession(accessToken, options = {}) {
    const token = String(accessToken || '').trim();
    if (!token) {
        return { ok: false, statusCode: 400, error: '缺少 AccessToken' };
    }

    const profile = {
        ...extractProfileFromToken(token),
        email: String(options.email || extractProfileFromToken(token).email || '').trim()
    };

    let response;
    try {
        response = await fetchAccountCheck(token, options);
    } catch (error) {
        if (error.code === 'LEASE_LOST') throw error;
        return {
            ok: false,
            statusCode: 502,
            errorCode: 'NETWORK_UNAVAILABLE',
            error: '订阅查询网络不可用，本次未取得账号订阅结果'
        };
    }

    if (response.errorCode) {
        const messages = {
            HUMAN_VERIFICATION_REQUIRED: '官网需要人工验证，请完成验证后再查询',
            NETWORK_TIMEOUT: '订阅查询网络超时，本次未取得账号订阅结果',
            PROXY_UNAVAILABLE: '任务代理连接失败，请检查代理服务',
            SESSION_INVALID: '账号尚未登录或 Session 已失效，请更新登录资料',
            NETWORK_UNAVAILABLE: '订阅查询网络不可用，本次未取得账号订阅结果'
        };
        const statuses = { NETWORK_TIMEOUT: 504, SESSION_INVALID: 401, HUMAN_VERIFICATION_REQUIRED: 403 };
        return { ok: false, errorCode: response.errorCode,
            statusCode: statuses[response.errorCode] || 502,
            error: messages[response.errorCode] };
    }
    const body = normalizeResponseBody(response.data);
    if (response.status !== 200) {
        const mapped = mapCheckError(response.status, body);
        return { ok: false, ...mapped };
    }

    if (!body || typeof body !== 'object') {
        return { ok: false, statusCode: 502, error: 'OpenAI 返回数据格式异常' };
    }

    return {
        ok: true,
        data: parseAccountCheckResponse(body, profile)
    };
}

module.exports = {
    BILLING_PAGE_URL,
    normalizeSubscriptionPlan,
    formatPurchaseOrigin,
    computeRemainingDays,
    parseAccountCheckResponse,
    validateSessionTokenForQuery,
    querySubscriptionBySession,
    cancelAutoRenew,
    resumeAutoRenew
};
