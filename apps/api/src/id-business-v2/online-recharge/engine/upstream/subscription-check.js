'use strict';

const { request: playwrightRequest } = require('playwright');
const { performance } = require('node:perf_hooks');
const { setTimeout, clearTimeout } = require('node:timers');
const { extractProfileFromToken } = require('./session-auth');
const { preparePlaywrightProxy } = require('./playwright-proxy');

const CHECK_V4_BASE = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27';
const CANCEL_SUBSCRIPTION_URL = 'https://chatgpt.com/backend-api/subscriptions/cancel';
const RESUME_SUBSCRIPTION_URL = 'https://chatgpt.com/backend-api/subscriptions/resume';
const BILLING_PAGE_URL = 'https://chatgpt.com/account/manage';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const ACCOUNT_MISMATCH_MESSAGE = '官网会话账号或用户与原任务不一致，已停止后续操作';
const BOOTSTRAP_FAILURE_MESSAGES = {
    SESSION_NOT_CONFIRMED: '官网首页的登录状态尚未确认，已停止后续操作',
    SESSION_BOOTSTRAP_FAILED: '官网登录初始化未完成，本次未取得订阅结果'
};

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

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
    'ECONNABORTED', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
function transportCode(error) {
    for (const value of [error?.networkCode, error?.code, error?.cause?.code])
        if (NETWORK_CODES.has(value) || /^net::ERR_[A-Z_]+$/.test(String(value || ''))) return value;
    const browser = String(error?.message || '').match(/\bnet::ERR_[A-Z_]+\b/);
    if (browser) return browser[0];
    return /timeout|timed out|AbortError/i.test(String(error?.name || '') + ' ' + String(error?.message || ''))
        ? 'ETIMEDOUT' : 'UNKNOWN';
}
function queryErrorCode(error) {
    if (['HUMAN_VERIFICATION_REQUIRED', 'SESSION_INVALID', 'ACCOUNT_MISMATCH', 'NETWORK_TIMEOUT',
        'SESSION_NOT_CONFIRMED', 'SESSION_BOOTSTRAP_FAILED'].includes(error?.code)) return error.code;
    if (/^(?:VERIFICATION_(?:TIMEOUT|CANCELLED|PAGE_CLOSED|FRAME_AMBIGUOUS|NOT_READY|NETWORK_UNAVAILABLE|PROVIDER_UNAVAILABLE|PROVIDER_REJECTED|RATE_LIMITED|CHALLENGE_REJECTED|CHALLENGE_UNCHANGED|ROUNDS_EXHAUSTED|SOLVER_DISABLED|SOLVER_FAILED|RUNTIME_FAILED|PAGE_BINDING_REQUIRED|PAGE_BINDING_MISMATCH|UNSUPPORTED)|VLM_(?:AUTH_FAILED|RATE_LIMITED|TIMEOUT|NETWORK_UNAVAILABLE|REQUEST_UNSUPPORTED|INVALID_RESPONSE|INVALID_DECISION|PROVIDER_UNAVAILABLE|IMAGE_UNSUPPORTED|NOT_CONFIGURED|API_REJECTED))$/.test(error?.code)) return error.code;
    const network = transportCode(error);
    if (network === 'ETIMEDOUT') return 'NETWORK_TIMEOUT';
    if (/PROXY|TUNNEL|SOCKS/.test(network) || network === 'ECONNREFUSED') return 'PROXY_UNAVAILABLE';
    return 'NETWORK_UNAVAILABLE';
}
function safeVerificationDiagnostics(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const result = {};
    for (const key of ['state', 'solverCode', 'providerCode']) {
        if (typeof value[key] === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,70}$/.test(value[key])) result[key] = value[key];
    }
    if (Number.isSafeInteger(value.revision) && value.revision >= 0) result.revision = value.revision;
    if (Number.isSafeInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) result.httpStatus = value.httpStatus;
    return Object.keys(result).length ? result : undefined;
}
function safeBootstrapDiagnostics(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return require('./session-auth').safeBootstrapDiagnostics(value);
}
function queryBudget(options) {
    const owned = !options.page && !options.browserContext;
    const signal = options.signal || require('../rpc.cjs').taskSignal?.();
    const deadlineAt = performance.now() + (owned ? 180000 : 45000);
    return { deadlineAt: Number.isFinite(options.deadlineAt) ? Math.min(deadlineAt, options.deadlineAt) : deadlineAt,
        signal, diagnostics: [], attempts: 0 };
}
function checkBudget(budget) {
    if (budget.signal?.aborted) throw Object.assign(new Error('任务已停止'), { code: 'LEASE_LOST' });
    if (performance.now() >= budget.deadlineAt)
        throw Object.assign(new Error('订阅查询已到期限'), { code: 'NETWORK_TIMEOUT', networkCode: 'ETIMEDOUT' });
    return Math.max(1, Math.ceil(budget.deadlineAt - performance.now()));
}
async function boundedQuery(operation, budget, phase) {
    const remaining = checkBudget(budget);
    let timer, onAbort;
    const halted = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('订阅查询已到期限'), {
            code: 'NETWORK_TIMEOUT', networkCode: 'ETIMEDOUT', phase
        })), remaining);
        onAbort = () => reject(Object.assign(new Error('任务已停止'), { code: 'LEASE_LOST' }));
        budget.signal?.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(operation), halted]); }
    catch (error) { if (!error.phase) error.phase = phase; throw error; }
    finally { clearTimeout(timer); budget.signal?.removeEventListener('abort', onAbort); }
}
async function queryGet(read, budget, transport) {
    const maximum = budget.maxAttempts === 1 ? 1 : 2;
    while (budget.attempts < maximum) {
        const started = performance.now(), attempt = ++budget.attempts;
        try {
            const timeoutMs = Math.min(10000, checkBudget(budget));
            const attemptBudget = { ...budget, deadlineAt: Math.min(budget.deadlineAt, started + timeoutMs) };
            const value = await boundedQuery(() => read(timeoutMs), attemptBudget, 'account_check');
            budget.diagnostics.push({ transport, phase: 'account_check', httpStatus: value.status,
                attempt, elapsedMs: Math.round(performance.now() - started) });
            return value;
        } catch (error) {
            if (error.code === 'LEASE_LOST') throw error;
            const code = transportCode(error);
            budget.diagnostics.push({ transport, phase: 'account_check', networkCode: code,
                attempt, elapsedMs: Math.round(performance.now() - started) });
            if (attempt >= maximum || !['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN',
                'net::ERR_CONNECTION_RESET', 'net::ERR_TIMED_OUT', 'net::ERR_NETWORK_CHANGED'].includes(code)) throw error;
            await boundedQuery(() => new Promise((resolve) => setTimeout(resolve, Math.min(500, checkBudget(budget)))), budget, 'retry_wait');
        }
    }
    throw Object.assign(new Error('订阅查询读取次数已耗尽'), { code: 'NETWORK_UNAVAILABLE' });
}
function officialPage(page) {
    try { const url = new URL(page.url()); return url.origin === 'https://chatgpt.com' && !page.isClosed?.(); }
    catch (_) { return false; }
}
async function readCheckInPage(page, accessToken, timezoneOffsetMin, budget) {
    if (!officialPage(page)) throw Object.assign(new Error('订阅查询页面来源不符'), { code: 'NETWORK_UNAVAILABLE' });
    return queryGet(async (timeoutMs) => {
        let observed;
        const failed = (request) => {
            if (request.url() !== buildCheckUrl(timezoneOffsetMin)) return;
            const code = String(request.failure()?.errorText || '').match(/\bnet::ERR_[A-Z_]+\b/)?.[0];
            if (code) observed = code;
        };
        page.on?.('requestfailed', failed);
        try {
            const result = await page.evaluate(async ({ url, token, timeoutMs }) => {
                if (location.origin !== 'https://chatgpt.com') return { status: 0, readError: 'ORIGIN_MISMATCH' };
                const control = new AbortController(), timer = setTimeout(() => control.abort(), timeoutMs);
                try {
                    const response = await fetch(url, { method: 'GET', credentials: 'include', cache: 'no-store',
                        redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: control.signal });
                    const text = await response.text();
                    return { status: response.status, text: text.length <= 512 * 1024 ? text : null };
                } catch (error) { return { status: 0, readError: error.name === 'AbortError' ? 'ETIMEDOUT' : 'NETWORK' }; }
                finally { clearTimeout(timer); }
            }, { url: buildCheckUrl(timezoneOffsetMin), token: accessToken, timeoutMs });
            if (result.readError) throw Object.assign(new Error('页面订阅读取未完成'), {
                networkCode: observed || (result.readError === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'UNKNOWN')
            });
            if (result.text === null) throw Object.assign(new Error('订阅响应超过限制'), { code: 'RESPONSE_TOO_LARGE' });
            return { status: result.status, data: normalizeResponseBody(result.text), via: 'browser-page' };
        } finally { page.off?.('requestfailed', failed); }
    }, budget, 'browser-page');
}
async function prepareQueryPage(context, budget) {
    const page = await boundedQuery(() => context.newPage(), budget, 'page_create');
    const verification = require('./human-verification');
    try {
        await verification.prepareVerificationPage?.(page, { signal: budget.signal });
        return page;
    } catch (error) { await page.close().catch(() => {}); throw error; }
}
async function closeQueryPage(page) {
    if (!page) return;
    await Promise.resolve(require('./human-verification').disposeVerificationPage?.(page)).catch(() => {});
    await page.close().catch(() => {});
}
async function withRenewalBrowserContext(accessToken, options, operation) {
    const budget = queryBudget(options);
    let prepared, session, context, page, finished = false;
    const runtime = require('./browser-runtime');
    const acquire = async (create, phase, dispose) => {
        checkBudget(budget);
        const pending = Promise.resolve().then(create);
        pending.then(resource => {
            if (finished) Promise.resolve(dispose(resource)).catch(() => {});
        }).catch(() => {});
        return boundedQuery(() => pending, budget, phase);
    };
    try {
        prepared = await acquire(() => preparePlaywrightProxy(String(process.env.PROXY || '').trim()),
            'proxy_prepare', resource => resource.cleanup());
        session = await acquire(() => runtime.connectTaskBrowser({ proxyConfig: prepared.proxyConfig,
            headful: process.env.HEADFUL === '1' }), 'browser_connect',
            resource => runtime.closeTaskBrowser(resource, resource.browser));
        context = await acquire(() => session.browser.newContext({ proxy: prepared.proxyConfig || undefined,
            userAgent: session.realUserAgent, locale: 'en-US' }), 'context_create', resource => resource.close());
        page = await acquire(() => prepareQueryPage(context, budget), 'page_create', closeQueryPage);
        const auth = require('./session-auth');
        const installed = await boundedQuery(() => auth.installChatGptSession(context, options.sessionRaw), budget, 'session_install');
        const login = await boundedQuery(() => auth.bootstrapChatGptSession(page, options.sessionRaw, {
            sessionData: installed?.sessionData || installed, cookieVerified: installed?.cookieVerified === true,
            deadlineAt: budget.deadlineAt, signal: budget.signal
        }), budget, 'session_bootstrap');
        return await operation(login.session?.accessToken || accessToken, { ...options, page,
            browserContext: context, signal: budget.signal, deadlineAt: budget.deadlineAt });
    } catch (error) {
        if (error.code === 'LEASE_LOST') throw error;
        const errorCode = queryErrorCode(error);
        const bootstrapDiagnostics = safeBootstrapDiagnostics(error.bootstrapDiagnostics);
        return { ok: false, resultUnknown: require('../rpc.cjs').wasSubmitted(),
            statusCode: errorCode === 'ACCOUNT_MISMATCH' ? 409 : errorCode === 'SESSION_NOT_CONFIRMED' ? 503 : 502, errorCode,
            ...(bootstrapDiagnostics ? { bootstrapDiagnostics } : {}),
            error: errorCode === 'ACCOUNT_MISMATCH' ? ACCOUNT_MISMATCH_MESSAGE
                : BOOTSTRAP_FAILURE_MESSAGES[errorCode] || '续费操作未能完成核验，请核对原任务，禁止重复提交' };
    } finally {
        finished = true;
        await closeQueryPage(page);
        if (context) await context.close().catch(() => {});
        if (session) await runtime.closeTaskBrowser(session, session.browser).catch(() => {});
        if (prepared) await prepared.cleanup().catch(() => {});
    }
}
async function fetchAccountCheck(accessToken, options = {}) {
    const budget = queryBudget(options);
    let cleanup = async () => {}, ownedContext, session, ownedPage, requestContext, verifiedCookie = false;
    try {
        let page = options.page;
        const context = options.browserContext || page?.context?.();
        if (context && !officialPage(page)) {
            page = context.pages?.().find(officialPage);
            if (!page) {
                ownedPage = page = await prepareQueryPage(context, budget);
                await boundedQuery(() => page.goto('https://chatgpt.com/', {
                    waitUntil: 'domcontentloaded', timeout: Math.min(20000, checkBudget(budget))
                }), budget, 'navigation');
            }
        }
        if (!page && options.sessionRaw && options.allowBrowserFallback === true) {
            const prepared = await boundedQuery(() => preparePlaywrightProxy(String(process.env.PROXY || '').trim()), budget, 'proxy_prepare');
            cleanup = prepared.cleanup;
            const runtime = require('./browser-runtime');
            session = await boundedQuery(() => runtime.connectTaskBrowser({ proxyConfig: prepared.proxyConfig,
                headful: process.env.HEADFUL === '1' }), budget, 'browser_connect');
            ownedContext = await boundedQuery(() => session.browser.newContext({ proxy: prepared.proxyConfig || undefined,
                userAgent: session.realUserAgent, locale: 'en-US' }), budget, 'context_create');
            ownedPage = page = await prepareQueryPage(ownedContext, budget);
            const auth = require('./session-auth');
            const installed = await boundedQuery(() => auth.installChatGptSession(ownedContext, options.sessionRaw), budget, 'session_install');
            verifiedCookie = installed?.cookieVerified === true;
            accessToken = installed?.sessionData?.accessToken || accessToken;
            const login = await boundedQuery(() => auth.bootstrapChatGptSession(page, options.sessionRaw, {
                sessionData: installed?.sessionData || installed, cookieVerified: installed?.cookieVerified === true,
                deadlineAt: budget.deadlineAt, signal: budget.signal
            }), budget, 'session_bootstrap');
            accessToken = login.session?.accessToken || accessToken;
        }
        if (page) {
            const verification = require('./human-verification');
            if (await boundedQuery(() => verification.isBlockingHumanVerificationVisible(page), budget, 'verification_probe')) {
                const result = await boundedQuery(() => verification.clearHumanVerification(page, {
                    phase: 'subscription-query', deadlineAt: budget.deadlineAt, signal: budget.signal,
                    maxWaitMs: checkBudget(budget), useVisualSolver: true, requireCheckoutReady: false
                }), budget, 'verification');
                if (!result.cleared) throw Object.assign(new Error('订阅查询验证未完成'), {
                    code: result.code || 'HUMAN_VERIFICATION_REQUIRED', diagnostics: result.diagnostics
                });
            }
            const result = await readCheckInPage(page, accessToken, options.timezoneOffsetMin, budget);
            return { ...result, diagnostics: budget.diagnostics };
        }
        // Token-only callers retain the explicit task-proxy transport; browser callers never
        // silently leave their Chromium network stack or change the resolved proxy.
        const prepared = await boundedQuery(() => preparePlaywrightProxy(String(process.env.PROXY || '').trim()), budget, 'proxy_prepare');
        cleanup = prepared.cleanup;
        requestContext = await boundedQuery(() => playwrightRequest.newContext({ userAgent: USER_AGENT,
            proxy: prepared.proxyConfig || undefined, extraHTTPHeaders: buildCheckHeaders(accessToken) }), budget, 'request_create');
        const result = await queryGet(async (timeout) => {
            const response = await requestContext.get(buildCheckUrl(options.timezoneOffsetMin), { timeout,
                headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
            let data;
            try { data = await response.json(); } catch (_) { data = await response.text().catch(() => ''); }
            return { status: response.status(), data, via: 'proxy-request' };
        }, budget, 'proxy-request');
        return { ...result, diagnostics: budget.diagnostics };
    } catch (error) {
        if (error.code === 'LEASE_LOST') throw error;
        // A stopped login may still expose why the official read-only endpoint disagrees
        // with the UI. This observation cannot turn the failed bootstrap into success.
        if (error.code === 'SESSION_NOT_CONFIRMED' && verifiedCookie && ownedContext
            && officialPage(ownedPage) && error.phase === 'session_bootstrap'
            && ['visible_login_controls', 'visible_login_content', 'login_not_confirmed'].includes(error.bootstrapDiagnostics?.reason)
            && error.bootstrapDiagnostics?.challengeDetected !== true
            && error.bootstrapDiagnostics?.redirectDetected !== true
            && !budget.signal?.aborted && budget.deadlineAt > performance.now()) {
            try {
                const probeBudget = { ...budget, attempts: 0, maxAttempts: 1,
                    deadlineAt: Math.min(budget.deadlineAt, performance.now() + 5000) };
                const blocked = await boundedQuery(() => require('./human-verification')
                    .isBlockingHumanVerificationVisible(ownedPage), probeBudget, 'verification_probe');
                if (!blocked) {
                    const probe = await readCheckInPage(ownedPage, accessToken, options.timezoneOffsetMin, probeBudget);
                    const body = normalizeResponseBody(probe.data);
                    const observed = body?.accounts?.default?.account?.account_id;
                    const hasFacts = probe.status === 200 && typeof observed === 'string'
                        && observed.length > 0 && typeof body?.accounts?.default?.entitlement?.has_active_subscription === 'boolean';
                    const expected = require('./session-auth').extractProfileFromToken(accessToken).accountId;
                    const facts = { accountCheckHttpStatus: probe.status,
                        accountCheckHasAccountFacts: hasFacts,
                        accountCheckIdentityMatches: hasFacts && Boolean(expected) && observed === expected };
                    error.bootstrapDiagnostics = { ...error.bootstrapDiagnostics, ...facts };
                    console.warn('[Session] 首页未确认，已完成只读订阅诊断', facts);
                }
            } catch (probeError) {
                if (probeError.code === 'LEASE_LOST') throw probeError;
                // queryGet already retained only bounded transport diagnostics.
            }
        }
        const bootstrapDiagnostics = safeBootstrapDiagnostics(error.bootstrapDiagnostics);
        return { status: 0, errorCode: queryErrorCode(error), data: null, diagnostics: budget.diagnostics,
            ...(bootstrapDiagnostics ? { bootstrapDiagnostics } : {}),
            verificationDiagnostics: safeVerificationDiagnostics(error.diagnostics),
            failure: { phase: ['account_check', 'session_install', 'session_bootstrap', 'navigation', 'proxy_prepare',
                'browser_connect', 'context_create', 'page_create', 'request_create', 'verification', 'verification_probe'].includes(error.phase)
                ? error.phase : 'query', networkCode: transportCode(error) } };
    } finally {
        await closeQueryPage(ownedPage);
        if (ownedContext) await ownedContext.close().catch(() => {});
        if (session) await require('./browser-runtime').closeTaskBrowser(session, session.browser);
        if (requestContext) await requestContext.dispose().catch(() => {});
        await cleanup().catch(() => {});
    }
}

async function requestOpenAiJson(accessToken, { method = 'GET', url, body = null }, options = {}) {
    const headers = buildCheckHeaders(accessToken);
    const proxyValue = String(process.env.PROXY || '').trim();
    const budget = queryBudget(options);
    let lastError = null;
    let ctx, ownsRequest = false, cleanup = async () => {};

    try {
        checkBudget(budget);
        const context = options.browserContext || options.page?.context?.();
        if (context) {
            // APIRequestContext belongs to this already authenticated browser;
            // its Cookie jar and resolved task proxy remain the same for one POST.
            ctx = context.request;
            if (typeof ctx?.fetch !== 'function') throw new Error('续费请求上下文不可用');
        } else {
            const prepared = await boundedQuery(() => preparePlaywrightProxy(proxyValue), budget, 'proxy_prepare');
            cleanup = prepared.cleanup;
            ctx = await boundedQuery(() => playwrightRequest.newContext({
                userAgent: USER_AGENT, proxy: prepared.proxyConfig || undefined, extraHTTPHeaders: headers
            }), budget, 'request_create');
            ownsRequest = true;
        }
        if (method !== 'GET') await boundedQuery(() => require('../rpc.cjs').beforeExternalSubmit({
            provider: 'local',
            stage: 'renewal_update',
            renewalAction: url === RESUME_SUBSCRIPTION_URL ? 'enable' : 'disable'
        }), budget, 'renewal_update');
        const response = await boundedQuery(() => ctx.fetch(url, {
            method,
            timeout: Math.min(20000, checkBudget(budget)),
            headers: body != null ? { ...headers, 'Content-Type': 'application/json' } : headers,
            data: body != null ? body : undefined
        }), budget, 'renewal_update');
        const status = response.status();
        // A successful POST response is not the final subscription state. Clear the
        // in-flight marker only after a matching account readback, or an auth rejection.
        if (method !== 'GET' && [401, 403].includes(status)) require('../rpc.cjs').recordKnownOutcome();
        const data = await boundedQuery(async () => {
            try {
                return await response.json();
            } catch (_) {
                return response.text().catch(() => '');
            }
        }, budget, 'renewal_update');
        if (status >= 200 && status < 300 || status === 401)
            return { status, data, via: 'playwright' };
        lastError = { status, data, via: 'playwright' };
    } catch (error) {
        if (error.code === 'LEASE_LOST') throw error;
        lastError = { status: 0, data: 'renewal_request_unavailable', via: 'playwright' };
    } finally {
        if (ownsRequest) await ctx?.dispose().catch(() => {});
        await cleanup().catch(() => {});
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
        ...options,
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

    if (!options.page && !options.browserContext && options.sessionRaw && options.allowBrowserFallback === true)
        return withRenewalBrowserContext(token, { ...options, accountId }, cancelAutoRenew);
    options = { ...options, deadlineAt: queryBudget(options).deadlineAt };

    const checkResult = await querySubscriptionBySession(token, {
        ...options,
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
        }, options);
    } catch (error) {
        if (error.code === 'LEASE_LOST') throw error;
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

    if (!options.page && !options.browserContext && options.sessionRaw && options.allowBrowserFallback === true)
        return withRenewalBrowserContext(token, { ...options, accountId }, resumeAutoRenew);
    options = { ...options, deadlineAt: queryBudget(options).deadlineAt };

    const checkResult = await querySubscriptionBySession(token, {
        ...options,
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
        }, options);
    } catch (error) {
        if (error.code === 'LEASE_LOST') throw error;
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

    return {
        statusCode: status || 502,
        error: `官网订阅接口返回异常 (${status})，本次未取得有效订阅结果`
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
        const mismatch = error.code === 'ACCOUNT_MISMATCH';
        const bootstrapError = Object.hasOwn(BOOTSTRAP_FAILURE_MESSAGES, error.code || '') ? error.code : null;
        const bootstrapDiagnostics = safeBootstrapDiagnostics(error.bootstrapDiagnostics);
        return {
            ok: false,
            statusCode: mismatch ? 409 : bootstrapError === 'SESSION_NOT_CONFIRMED' ? 503 : 502,
            errorCode: mismatch ? 'ACCOUNT_MISMATCH' : bootstrapError || 'NETWORK_UNAVAILABLE',
            ...(bootstrapDiagnostics ? { bootstrapDiagnostics } : {}),
            error: mismatch ? ACCOUNT_MISMATCH_MESSAGE : BOOTSTRAP_FAILURE_MESSAGES[bootstrapError]
                || '订阅查询网络不可用，本次未取得账号订阅结果'
        };
    }

    if (response.errorCode) {
        const messages = {
            HUMAN_VERIFICATION_REQUIRED: '官网需要人工验证，请完成验证后再查询',
            NETWORK_TIMEOUT: '订阅查询网络超时，本次未取得账号订阅结果',
            PROXY_UNAVAILABLE: '任务代理连接失败，请检查代理服务',
            SESSION_INVALID: '账号尚未登录或 Session 已失效，请更新登录资料',
            ACCOUNT_MISMATCH: ACCOUNT_MISMATCH_MESSAGE,
            ...BOOTSTRAP_FAILURE_MESSAGES,
            NETWORK_UNAVAILABLE: '订阅查询网络不可用，本次未取得账号订阅结果'
        };
        const statuses = { NETWORK_TIMEOUT: 504, SESSION_INVALID: 401, HUMAN_VERIFICATION_REQUIRED: 403, ACCOUNT_MISMATCH: 409,
            SESSION_NOT_CONFIRMED: 503, SESSION_BOOTSTRAP_FAILED: 502 };
        const bootstrapDiagnostics = safeBootstrapDiagnostics(response.bootstrapDiagnostics);
        return { ok: false, errorCode: response.errorCode,
            statusCode: statuses[response.errorCode] || (/TIMEOUT$/.test(response.errorCode) ? 504
                : /^(?:VERIFICATION_|VLM_)/.test(response.errorCode) ? 503 : 502),
            error: messages[response.errorCode] || '官网验证未完成，本次订阅查询未取得有效结果', diagnostics: response.diagnostics,
            verificationDiagnostics: response.verificationDiagnostics,
            ...(bootstrapDiagnostics ? { bootstrapDiagnostics } : {}), failure: response.failure };
    }
    const body = normalizeResponseBody(response.data);
    if (response.status !== 200) {
        const mapped = mapCheckError(response.status, body);
        return { ok: false, ...mapped, diagnostics: response.diagnostics };
    }

    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        typeof body.accounts?.default?.account?.account_id !== 'string' ||
        typeof body.accounts?.default?.entitlement?.has_active_subscription !== 'boolean') {
        return { ok: false, statusCode: 502, errorCode: 'UPSTREAM_INVALID_RESPONSE',
            error: '官网订阅响应缺少有效账号或订阅状态', diagnostics: response.diagnostics };
    }

    return {
        ok: true,
        data: parseAccountCheckResponse(body, profile), diagnostics: response.diagnostics
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
