/**
 * 兼容 createTask / getTaskResult 协议的打码平台（Capsolver、2Captcha Enterprise 等）
 * 用于浏览器 passive hCaptcha 兜底。
 */

const { createVerificationBudget, controlledVerificationCode } = require('./verification-runtime');

const DEFAULT_API_URL = 'https://api.capsolver.com';
const STRIPE_HCAPTCHA_SITEKEY_FALLBACK = 'c7faac4c-1cd7-4b1b-b2d4-42ba98d09c7a';

const PROVIDER_API_BASE = {
    'anti-captcha': 'https://api.anti-captcha.com',
    capsolver: 'https://api.capsolver.com',
    '2captcha': 'https://api.2captcha.com'
};

function guessCaptchaKeyProvider(apiKey) {
    const key = String(apiKey || '').trim();
    if (/^CAP-/i.test(key)) {
        return 'capsolver';
    }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
        return 'anti-captcha';
    }
    if (/^[0-9a-f]{32}$/i.test(key)) {
        return 'anti-captcha';
    }
    return 'unknown';
}

function guessCaptchaUrlProvider(apiUrl) {
    const url = String(apiUrl || '').toLowerCase();
    if (url.includes('capsolver')) {
        return 'capsolver';
    }
    if (url.includes('anti-captcha') || url.includes('anticaptcha')) {
        return 'anti-captcha';
    }
    if (url.includes('2captcha')) {
        return '2captcha';
    }
    return 'unknown';
}

function describeCaptchaProvider(id) {
    const map = {
        capsolver: 'Capsolver（Key 以 CAP- 开头，地址 api.capsolver.com）',
        'anti-captcha': 'Anti-Captcha（账户 API Key，地址 api.anti-captcha.com）',
        '2captcha': '2Captcha（地址 api.2captcha.com）',
        unknown: '未知平台'
    };
    return map[id] || id;
}

function checkCaptchaPlatformCredentialMatch(apiKey, apiUrl) {
    const keyProvider = guessCaptchaKeyProvider(apiKey);
    const urlProvider = guessCaptchaUrlProvider(apiUrl);
    if (keyProvider === 'unknown' || urlProvider === 'unknown' || keyProvider === urlProvider) {
        return null;
    }
    return `API Key 形态像 ${describeCaptchaProvider(keyProvider)}，但 API 地址是 ${describeCaptchaProvider(urlProvider)}，二者必须来自同一平台。`;
}

/** 根据 Key 自动纠正 API 根地址（Anti-Captcha 文档: https://api.anti-captcha.com/createTask） */
function resolveCaptchaPlatformCredentials(apiKey, apiUrl) {
    const key = String(apiKey || '').trim();
    let url = normalizeCaptchaPlatformApiUrl(apiUrl);
    const keyProvider = guessCaptchaKeyProvider(key);
    const urlProvider = guessCaptchaUrlProvider(url);
    let autoFixed = false;
    let note = '';

    if (keyProvider !== 'unknown' && keyProvider !== urlProvider) {
        const fixed = PROVIDER_API_BASE[keyProvider];
        if (fixed && fixed !== url) {
            url = fixed;
            autoFixed = true;
            note = `已根据您的 Key 自动使用 ${url}（与 Anti-Captcha 官方 API 一致，见 apidoc/createTask）`;
        }
    }

    const provider = keyProvider !== 'unknown' ? keyProvider : urlProvider;
    return { apiKey: key, apiUrl: url, provider, autoFixed, note };
}

/** 常见误填官网域名 → 自动改为 API 根地址 */
function normalizeCaptchaPlatformApiUrl(rawUrl) {
    let url = String(rawUrl || '').trim().replace(/\/+$/, '');
    if (!url) {
        return DEFAULT_API_URL;
    }
    try {
        const parsed = new URL(url.includes('://') ? url : `https://${url}`);
        const host = parsed.hostname.toLowerCase();
        const hostFixes = {
            'anti-captcha.com': 'api.anti-captcha.com',
            'www.anti-captcha.com': 'api.anti-captcha.com',
            'capsolver.com': 'api.capsolver.com',
            'www.capsolver.com': 'api.capsolver.com',
            '2captcha.com': 'api.2captcha.com',
            'www.2captcha.com': 'api.2captcha.com'
        };
        if (hostFixes[host]) {
            parsed.hostname = hostFixes[host];
            url = parsed.origin;
        }
        // 去掉误填的路径后缀（如 /getBalance）
        if (parsed.pathname && parsed.pathname !== '/') {
            url = parsed.origin;
        }
        return url.replace(/\/+$/, '') || DEFAULT_API_URL;
    } catch (_) {
        return url.replace(/\/+$/, '') || DEFAULT_API_URL;
    }
}

function platformLog(phase, message, level = 'info') {
    const tag = level === 'warn' ? 'WARN' : level === 'error' ? 'ERROR' : 'INFO';
    console.log(`CAPTCHA_LOG: [Captcha/${phase}][${tag}] ${message}`);
}

function getCaptchaPlatformConfig() {
    const apiKey = String(
        process.env.HCAPTCHA_CAPTCHA_PLATFORM_API_KEY
        || process.env.CAPTCHA_PLATFORM_API_KEY
        || process.env.CTF_CAPTCHA_API_KEY
        || process.env.CTF_CAPTCHA_CLIENT_KEY
        || process.env.CAPTCHA_API_KEY
        || process.env.CAPTCHA_CLIENT_KEY
        || ''
    ).trim();
    const apiUrl = normalizeCaptchaPlatformApiUrl(
        process.env.HCAPTCHA_CAPTCHA_PLATFORM_API_URL
        || process.env.CAPTCHA_PLATFORM_API_URL
        || process.env.CTF_CAPTCHA_API_URL
        || process.env.CAPTCHA_API_URL
        || DEFAULT_API_URL
    );
    const timeoutSec = Math.max(
        30,
        Number(process.env.HCAPTCHA_CAPTCHA_PLATFORM_TIMEOUT || process.env.CAPTCHA_PLATFORM_TIMEOUT || 180) || 180
    );
    return { apiKey, apiUrl, timeoutSec };
}

function isCaptchaPlatformEnabled() {
    const { apiKey, apiUrl } = getCaptchaPlatformConfig();
    if (!apiKey || !apiUrl) {
        return false;
    }
    if (apiKey.includes('YOUR_') || apiUrl.includes('YOUR_')) {
        return false;
    }
    return true;
}

function normalizeHcaptchaPlatformConfig(raw = {}) {
    return {
        captcha_platform_api_key: String(raw.captcha_platform_api_key || '').trim(),
        captcha_platform_api_url: normalizeCaptchaPlatformApiUrl(raw.captcha_platform_api_url || DEFAULT_API_URL),
        captcha_platform_timeout: Math.max(30, Number(raw.captcha_platform_timeout || 180) || 180)
    };
}

function applyCaptchaPlatformConfigToEnv(cfg = {}) {
    const normalized = normalizeHcaptchaPlatformConfig(cfg);
    const patch = {};
    if (normalized.captcha_platform_api_key) {
        patch.HCAPTCHA_CAPTCHA_PLATFORM_API_KEY = normalized.captcha_platform_api_key;
        patch.CAPTCHA_PLATFORM_API_KEY = normalized.captcha_platform_api_key;
    }
    if (normalized.captcha_platform_api_url) {
        patch.HCAPTCHA_CAPTCHA_PLATFORM_API_URL = normalized.captcha_platform_api_url;
        patch.CAPTCHA_PLATFORM_API_URL = normalized.captcha_platform_api_url;
    }
    patch.HCAPTCHA_CAPTCHA_PLATFORM_TIMEOUT = String(normalized.captcha_platform_timeout);
    return patch;
}

async function postJson(url, payload, timeoutMs = 20000, signal) {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        let data = {};
        try {
            data = await response.json();
        } catch (_) {
            throw Object.assign(new Error('验证服务返回格式错误'), { code: 'VERIFICATION_SOLVER_FAILED' });
        }
        if (!response.ok) {
            const code = response.status === 429 ? 'VERIFICATION_RATE_LIMITED'
                : response.status >= 500 ? 'VERIFICATION_PROVIDER_UNAVAILABLE' : 'VERIFICATION_PROVIDER_REJECTED';
            throw Object.assign(new Error('验证服务请求未通过'), { code });
        }
        return data;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
    }
}

async function createCaptchaTask(task, config = null) {
    const cfg = config || getCaptchaPlatformConfig();
    const data = await postJson(`${cfg.apiUrl}/createTask`, {
        clientKey: cfg.apiKey,
        task
    }, cfg.budget ? cfg.budget.timeout(20000) : 20000, cfg.budget?.signal);
    if (Number(data.errorId) !== 0) {
        throw Object.assign(new Error('验证服务拒绝创建任务'), { code: 'VERIFICATION_PROVIDER_REJECTED' });
    }
    if (!data.taskId) {
        throw Object.assign(new Error('验证服务未返回任务标识'), { code: 'VERIFICATION_SOLVER_FAILED' });
    }
    return data.taskId;
}

async function pollCaptchaTaskResult(taskId, config = null, options = {}) {
    const cfg = config || getCaptchaPlatformConfig();
    const budget = options.budget || cfg.budget || createVerificationBudget({ maxWaitMs: Number(options.timeoutSec || cfg.timeoutSec) * 1000 });
    const owned = !options.budget && !cfg.budget;
    const tokenFields = options.tokenFields || ['gRecaptchaResponse', 'hcaptchaToken', 'token'];
    let polls = 0;
    try {
        while (budget.remaining() > 0) {
            await budget.wait(++polls === 1 ? 1200 : 3000);
            const data = await budget.run(postJson(`${cfg.apiUrl}/getTaskResult`, {
                clientKey: cfg.apiKey, taskId
            }, budget.timeout(20000), budget.signal));
            if (Number(data.errorId) !== 0) throw Object.assign(new Error('验证服务拒绝请求'), { code: 'VERIFICATION_PROVIDER_REJECTED' });
            if (data.status !== 'ready') continue;
            const solution = data.solution || {};
            for (const field of tokenFields) {
                const token = solution[field] || data[field];
                if (token) return { token: String(token), ekey: String(solution.eKey || solution.respKey || solution.ekey || ''), taskId };
            }
            throw Object.assign(new Error('验证服务返回结果不完整'), { code: 'VERIFICATION_SOLVER_FAILED' });
        }
        throw Object.assign(new Error('验证服务超过本次期限'), { code: 'VERIFICATION_TIMEOUT' });
    } finally { if (owned) budget.dispose(); }
}

function buildHcaptchaTaskVariants({
    siteKey,
    websiteUrls = [],
    rqdata = '',
    isInvisible = true,
    userAgent = '',
    provider = 'unknown'
}) {
    const urls = [...new Set(websiteUrls.filter(Boolean))];
    if (!urls.length) {
        urls.push('https://js.stripe.com/');
    }
    const strategies = [];
    const useAntiCaptcha = provider === 'anti-captcha';

    for (const websiteURL of urls) {
        if (useAntiCaptcha) {
            const base = {
                type: 'HCaptchaTaskProxyless',
                websiteURL,
                websiteKey: siteKey
            };
            if (isInvisible) {
                base.isInvisible = true;
            }
            if (userAgent) {
                base.userAgent = userAgent;
            }
            if (rqdata) {
                strategies.push({
                    ...base,
                    enterprisePayload: { rqdata, sentry: true }
                });
            }
            strategies.push(base);
            continue;
        }

        for (const isEnterprise of [true, false]) {
            const base = {
                type: 'HCaptchaTaskProxyless',
                websiteURL,
                websiteKey: siteKey,
                isEnterprise
            };
            if (isInvisible) {
                base.isInvisible = true;
            }
            if (rqdata) {
                base.rqdata = rqdata;
            }
            if (userAgent) {
                base.userAgent = userAgent;
            }
            strategies.push(base);
        }
    }
    return strategies;
}

async function solveHcaptchaViaPlatform(params = {}, config = null, options = {}) {
    const rawCfg = config || getCaptchaPlatformConfig();
    const budget = options.budget || createVerificationBudget({ signal: options.signal,
        deadlineAt: options.deadlineAt, maxWaitMs: Number(rawCfg.timeoutSec || 180) * 1000 });
    const resolved = resolveCaptchaPlatformCredentials(rawCfg.apiKey, rawCfg.apiUrl);
    const cfg = { ...rawCfg, apiKey: resolved.apiKey, apiUrl: resolved.apiUrl, budget };
    try {
        if (!cfg.apiKey || !cfg.apiUrl) return { ok: false, code: 'VERIFICATION_SOLVER_DISABLED' };
        const strategies = buildHcaptchaTaskVariants({
            siteKey: String(params.siteKey || STRIPE_HCAPTCHA_SITEKEY_FALLBACK).trim(),
            websiteUrls: Array.isArray(params.websiteUrls) ? params.websiteUrls : [],
            rqdata: String(params.rqdata || ''), isInvisible: params.isInvisible !== false,
            userAgent: String(params.userAgent || process.env.HCAPTCHA_USER_AGENT || ''), provider: resolved.provider
        });
        // One provider task per observed challenge. A rejected/unknown task is not recreated with guesses.
        const task = strategies[0];
        budget.assert();
        const taskId = await budget.run(createCaptchaTask(task, cfg));
        const result = await pollCaptchaTaskResult(taskId, cfg, { budget });
        return { ok: true, token: result.token, ekey: result.ekey, taskId };
    } catch (error) {
        const code = budget.signal.aborted ? budget.signal.reason?.code : error.code;
        if (code === 'LEASE_LOST') throw error;
        return { ok: false, code: controlledVerificationCode(code, 'VERIFICATION_PROVIDER_UNAVAILABLE') };
    } finally { if (!options.budget) budget.dispose(); }
}

async function extractHcaptchaParamsFromPage(page) {
    const pageUrl = String(page.url() || '').trim();
    const extracted = await page.evaluate(() => {
        const siteKeys = [];
        const rqdataList = [];
        const urls = [];

        const addSiteKey = (value) => {
            const sk = String(value || '').trim();
            if (sk && !siteKeys.includes(sk)) {
                siteKeys.push(sk);
            }
        };
        const addRqdata = (value) => {
            const rq = String(value || '').trim();
            if (rq && !rqdataList.includes(rq)) {
                rqdataList.push(rq);
            }
        };
        const addUrl = (value) => {
            const u = String(value || '').trim();
            if (u && !urls.includes(u)) {
                urls.push(u);
            }
        };

        document.querySelectorAll('[data-sitekey]').forEach((el) => {
            addSiteKey(el.getAttribute('data-sitekey'));
        });

        document.querySelectorAll('iframe[src]').forEach((iframe) => {
            const src = iframe.getAttribute('src') || '';
            if (!src) {
                return;
            }
            try {
                const parsed = new URL(src, window.location.href);
                addSiteKey(parsed.searchParams.get('sitekey'));
                addRqdata(parsed.searchParams.get('rqdata'));
                if (/hcaptcha|stripecdn|stripe/i.test(src)) {
                    addUrl(parsed.href);
                }
            } catch (_) { /* ignore */ }
        });

        const html = document.documentElement?.innerHTML || '';
        const patterns = [
            [/"site_key"\s*:\s*"([^"]+)"/g, addSiteKey],
            [/"sitekey"\s*:\s*"([^"]+)"/g, addSiteKey],
            [/hcaptcha_site_key"\s*:\s*"([^"]+)"/g, addSiteKey],
            [/"rqdata"\s*:\s*"([^"]+)"/g, addRqdata],
            [/hcaptcha_rqdata"\s*:\s*"([^"]+)"/g, addRqdata],
            [/rqdata['"]\s*:\s*['"]([^'"]+)['"]/g, addRqdata],
            [/\\"rqdata\\"\s*:\s*\\"([^"\\]+)\\"/g, addRqdata]
        ];
        for (const [regex, adder] of patterns) {
            for (const match of html.matchAll(regex)) {
                adder(match[1]);
            }
        }

        return { siteKeys, rqdataList, urls };
    }).catch(() => ({ siteKeys: [], rqdataList: [], urls: [] }));

    for (const frame of page.frames()) {
        const frameUrl = frame.url() || '';
        if (!frameUrl) {
            continue;
        }
        try {
            const parsed = new URL(frameUrl);
            const sk = parsed.searchParams.get('sitekey');
            const rq = parsed.searchParams.get('rqdata');
            if (sk && !extracted.siteKeys.includes(sk)) {
                extracted.siteKeys.push(sk);
            }
            if (rq && !extracted.rqdataList.includes(rq)) {
                extracted.rqdataList.push(rq);
            }
            if (/hcaptcha|stripecdn|stripe/i.test(frameUrl)) {
                extracted.urls.push(frameUrl);
            }
        } catch (_) { /* ignore */ }
    }

    const websiteUrls = new Set(extracted.urls);
    if (pageUrl) {
        websiteUrls.add(pageUrl);
    }
    websiteUrls.add('https://js.stripe.com/');
    websiteUrls.add('https://b.stripecdn.com/stripethirdparty-srv/assets/v1/HCaptcha.html');
    websiteUrls.add('https://b.stripecdn.com/stripethirdparty-srv/assets/v1/HCaptchaInvisible.html');

    return {
        siteKey: extracted.siteKeys[0] || STRIPE_HCAPTCHA_SITEKEY_FALLBACK,
        rqdata: extracted.rqdataList[0] || '',
        websiteUrls: [...websiteUrls],
        allSiteKeys: extracted.siteKeys
    };
}

async function injectHcaptchaTokenOnPage(page, token, ekey = '') {
    const tokenStr = String(token || '').trim();
    if (!tokenStr) {
        return { ok: false, reason: 'empty_token' };
    }
    const ekeyStr = String(ekey || '').trim();

    await page.evaluate(({ tokenValue, ekeyValue }) => {
        const fillTextareas = () => {
            const selectors = [
                'textarea[name="h-captcha-response"]',
                'textarea[name="g-recaptcha-response"]',
                '#h-captcha-response',
                '#g-recaptcha-response'
            ];
            for (const sel of selectors) {
                document.querySelectorAll(sel).forEach((el) => {
                    el.value = tokenValue;
                    el.innerHTML = tokenValue;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                });
            }
        };
        fillTextareas();

        if (typeof window.hcaptcha !== 'undefined' && window.hcaptcha) {
            try {
                const ids = typeof window.hcaptcha.getWidgetIds === 'function'
                    ? window.hcaptcha.getWidgetIds()
                    : [];
                for (const id of ids) {
                    window.hcaptcha.setResponse(id, tokenValue);
                }
            } catch (_) { /* ignore */ }
        }

        const childPayloads = [
            { type: 'response', response: tokenValue, ekey: ekeyValue },
            { tag: 'RESPONSE_HCAPTCHA_INVISIBLE', value: { response: tokenValue, key: ekeyValue } }
        ];
        for (const iframe of document.querySelectorAll('iframe')) {
            try {
                for (const payload of childPayloads) {
                    iframe.contentWindow?.postMessage({
                        type: 'stripe-third-party-child-to-parent',
                        payload
                    }, '*');
                }
            } catch (_) { /* ignore */ }
        }
        for (const payload of childPayloads) {
            window.postMessage({
                type: 'stripe-third-party-child-to-parent',
                payload
            }, '*');
        }
    }, { tokenValue: tokenStr, ekeyValue: ekeyStr });

    for (const frame of page.frames()) {
        const frameUrl = frame.url() || '';
        if (!/hcaptcha/i.test(frameUrl)) {
            continue;
        }
        try {
            await frame.evaluate((tokenValue) => {
                document.querySelectorAll('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]')
                    .forEach((el) => {
                        el.value = tokenValue;
                        el.innerHTML = tokenValue;
                    });
                if (window.parent && window.parent !== window) {
                    window.parent.postMessage({
                        type: 'stripe-third-party-child-to-parent',
                        payload: { type: 'response', response: tokenValue }
                    }, '*');
                }
            }, tokenStr);
        } catch (_) { /* ignore */ }
    }

    return { ok: true };
}

async function clickCheckoutContinueAfterCaptcha() {
    // Compatibility export only. Verification recovery must never click a merchant payment button.
    return false;
}

async function testCaptchaPlatformConnectivity(config = null) {
    const raw = config && typeof config === 'object' ? config : {};
    const fromEnv = getCaptchaPlatformConfig();
    const mergedKey = String(
        raw.apiKey
        || raw.captcha_platform_api_key
        || fromEnv.apiKey
        || ''
    ).trim();
    const mergedUrl = normalizeCaptchaPlatformApiUrl(
        raw.apiUrl
        || raw.captcha_platform_api_url
        || fromEnv.apiUrl
        || DEFAULT_API_URL
    );
    const resolved = resolveCaptchaPlatformCredentials(mergedKey, mergedUrl);
    const cfg = {
        apiKey: resolved.apiKey,
        apiUrl: resolved.apiUrl,
        timeoutSec: raw.timeoutSec || raw.captcha_platform_timeout || fromEnv.timeoutSec
    };
    if (!cfg.apiKey) {
        return { ok: false, message: '未配置打码平台 API Key' };
    }
    if (!cfg.apiUrl) {
        return { ok: false, message: '未配置打码平台 API URL' };
    }
    try {
        const data = await postJson(`${cfg.apiUrl}/getBalance`, { clientKey: cfg.apiKey });
        if (Number(data.errorId) !== 0) {
            const errText = String(data.errorDescription || data.errorCode || 'getBalance 失败');
            let message = errText;
            if (/clientkey|client.?key|invalid.*key|key.*invalid/i.test(errText)) {
                message = `${errText}：请确认 Key 来自 ${cfg.apiUrl} 对应平台，并在后台重新粘贴 Key 后保存。`;
            }
            return {
                ok: false,
                message,
                raw: data,
                apiUrl: cfg.apiUrl
            };
        }
        const balance = data.balance ?? data.availableBalance ?? data.funds;
        const prefix = resolved.note ? `${resolved.note} ` : '';
        return {
            ok: true,
            message: prefix + (balance !== undefined
                ? `打码平台连通正常（${cfg.apiUrl}），余额: ${balance}`
                : `打码平台连通正常（${cfg.apiUrl}）`),
            balance,
            apiUrl: cfg.apiUrl,
            autoFixed: resolved.autoFixed,
            raw: data
        };
    } catch (error) {
        return { ok: false, message: error.message || String(error) };
    }
}

module.exports = {
    DEFAULT_API_URL,
    STRIPE_HCAPTCHA_SITEKEY_FALLBACK,
    normalizeCaptchaPlatformApiUrl,
    guessCaptchaKeyProvider,
    guessCaptchaUrlProvider,
    resolveCaptchaPlatformCredentials,
    checkCaptchaPlatformCredentialMatch,
    getCaptchaPlatformConfig,
    isCaptchaPlatformEnabled,
    normalizeHcaptchaPlatformConfig,
    applyCaptchaPlatformConfigToEnv,
    createCaptchaTask,
    pollCaptchaTaskResult,
    solveHcaptchaViaPlatform,
    extractHcaptchaParamsFromPage,
    injectHcaptchaTokenOnPage,
    clickCheckoutContinueAfterCaptcha,
    testCaptchaPlatformConnectivity
};
