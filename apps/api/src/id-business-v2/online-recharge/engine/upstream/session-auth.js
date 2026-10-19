'use strict';

const CHATGPT_ORIGIN = 'https://chatgpt.com';
function isOfficialSessionUrl(raw) {
    try {
        const url = new URL(raw);
        return url.protocol === 'https:' && !url.port
            && ['chatgpt.com', 'openai.com'].some((host) =>
                url.hostname === host || url.hostname.endsWith(`.${host}`));
    } catch (_) { return false; }
}
const {
    isLoginRedirectUrl,
    isHardLoginRedirectUrl,
    isCheckoutPageUrl,
    shouldBlockLoginNavigation,
    isLoginPageContent,
    hasVisibleLoginChrome,
    waitForLoggedInChatUi,
    hasLoggedInSessionApi
} = require('./auth-page-detect');

const BOOTSTRAP_REASONS = new Set([
    'input_missing', 'identity_missing', 'login_redirect', 'visible_login_content',
    'visible_login_controls', 'login_not_confirmed', 'navigation_failed',
    'verification_failed', 'page_closed', 'runtime_failed'
]);
const BOOTSTRAP_FLAGS = [
    'authApiVerified', 'visibleLogin', 'loggedInUi', 'redirectDetected', 'challengeDetected', 'pageClosed',
    'accountCheckHasAccountFacts', 'accountCheckIdentityMatches'
];
function safeBootstrapDiagnostics(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const result = {};
    if (BOOTSTRAP_REASONS.has(value.reason)) result.reason = value.reason;
    for (const key of BOOTSTRAP_FLAGS) {
        if (typeof value[key] === 'boolean') result[key] = value[key];
    }
    if (Number.isInteger(value.accountCheckHttpStatus)
        && value.accountCheckHttpStatus >= 100 && value.accountCheckHttpStatus <= 599)
        result.accountCheckHttpStatus = value.accountCheckHttpStatus;
    return Object.keys(result).length ? result : undefined;
}
function sessionNotConfirmed(message, reason, diagnostics = {}) {
    const bootstrapDiagnostics = safeBootstrapDiagnostics({ ...diagnostics, reason });
    console.warn('[Session] 登录状态尚未确认', { code: 'SESSION_NOT_CONFIRMED', bootstrapDiagnostics });
    return Object.assign(new Error(message), { code: 'SESSION_NOT_CONFIRMED', bootstrapDiagnostics });
}

function decodeJwtPayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) {
        return null;
    }
    try {
        const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
        return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    } catch (_) {
        return null;
    }
}

function extractProfileFromToken(accessToken) {
    const payload = decodeJwtPayload(accessToken);
    if (!payload) {
        return { email: '', accountId: '', userId: '' };
    }
    const authInfo = payload['https://api.openai.com/auth'] || {};
    const profile = payload['https://api.openai.com/profile'] || {};
    return {
        email: profile.email || '',
        accountId: authInfo.chatgpt_account_id || '',
        userId: authInfo.chatgpt_user_id || ''
    };
}

function buildSessionPayload(accessToken, sessionJson = null) {
    const token = String(accessToken || '').trim();
    const profile = extractProfileFromToken(token);
    const base = sessionJson && typeof sessionJson === 'object' ? { ...sessionJson } : {};
    const user = base.user || (profile.email || profile.userId ? {
        id: profile.userId || `user-${profile.accountId || 'session'}`,
        email: profile.email || undefined,
        name: profile.email || undefined
    } : null);

    const expires = base.expires
        || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    return {
        ...base,
        user,
        expires,
        accessToken: base.accessToken || base.access_token || token,
        authProvider: base.authProvider || 'google-oauth2'
    };
}

function parseSessionJson(raw) {
    const content = String(raw || '').trim();
    if (!content || !content.startsWith('{')) {
        return null;
    }
    try {
        const data = JSON.parse(content);
        if (data?.accessToken || data?.access_token || data?.user) {
            return data;
        }
    } catch (_) {
        return null;
    }
    return null;
}

const CHATGPT_COOKIE_URL = 'https://chatgpt.com';
const SESSION_TOKEN_BASE = '__Secure-next-auth.session-token';
/** 与 NextAuth SessionStore 一致：4096 - 160 */
const SESSION_COOKIE_CHUNK_SIZE = 3936;

function isSessionTokenCookieName(name) {
    return name === SESSION_TOKEN_BASE || name.startsWith(`${SESSION_TOKEN_BASE}.`);
}

/** 超长 sessionToken 按 NextAuth 规则拆成 .0 / .1 / … 多块 Cookie */
function expandSessionTokenCookies(value) {
    const token = sanitizeCookieValue(value);
    if (!token) {
        return [];
    }
    if (token.length <= SESSION_COOKIE_CHUNK_SIZE) {
        return [{ name: SESSION_TOKEN_BASE, value: token }];
    }
    const chunkCount = Math.ceil(token.length / SESSION_COOKIE_CHUNK_SIZE);
    const chunks = [];
    for (let i = 0; i < chunkCount; i++) {
        chunks.push({
            name: `${SESSION_TOKEN_BASE}.${i}`,
            value: token.substr(i * SESSION_COOKIE_CHUNK_SIZE, SESSION_COOKIE_CHUNK_SIZE)
        });
    }
    return chunks;
}

function hasStoredSessionToken(cookies) {
    return (cookies || []).some((item) => isSessionTokenCookieName(item.name));
}

function parseCookieHeader(header) {
    const pairs = [];
    for (const rawPart of String(header || '').split(';')) {
        const part = rawPart.trim();
        if (!part || !part.includes('=')) continue;
        const eq = part.indexOf('=');
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (name && value) {
            pairs.push({ name, value });
        }
    }
    return pairs;
}

function isChatGptCookieDomain(domain) {
    const value = String(domain || '').toLowerCase();
    return !value || value.includes('chatgpt.com');
}

function normalizeSameSite(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (value === 'no_restriction' || value === 'none') {
        return 'None';
    }
    if (value === 'strict') {
        return 'Strict';
    }
    return 'Lax';
}

function sanitizeCookieValue(value) {
    return String(value || '')
        .replace(/^["']+|["']+$/g, '')
        .replace(/[\r\n\0]/g, '')
        .trim();
}

function isValidCookieName(name) {
    return /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/.test(name);
}

function toPlaywrightCookie(spec) {
    if (!spec || typeof spec !== 'object') {
        return null;
    }
    const name = String(spec.name || '').trim();
    const value = sanitizeCookieValue(spec.value);
    if (!name || !value || !isValidCookieName(name)) {
        return null;
    }

    const sameSite = normalizeSameSite(spec.sameSite);
    const secure = sameSite === 'None' || name.startsWith('__Host-') || name.startsWith('__Secure-')
        ? true
        : spec.secure !== false;
    const httpOnly = spec.httpOnly !== false;

    const base = { name, value, secure, httpOnly, sameSite };

    // __Host- / __Secure- 前缀：只能用 url，不能带 domain/path
    if (name.startsWith('__Host-') || name.startsWith('__Secure-')) {
        return { ...base, url: CHATGPT_COOKIE_URL };
    }

    const hostOnly = spec.hostOnly === true;
    const rawDomain = String(spec.domain || 'chatgpt.com').trim().toLowerCase() || 'chatgpt.com';
    const bareDomain = rawDomain.replace(/^\./, '');
    const domain = hostOnly ? bareDomain : (rawDomain.startsWith('.') ? rawDomain : `.${bareDomain}`);
    const path = String(spec.path || '/').trim() || '/';

    return { ...base, domain, path };
}

function toPlaywrightCookieFallback(cookie) {
    if (!cookie?.name || !cookie?.value) {
        return null;
    }
    const { name, value, secure, httpOnly, sameSite } = cookie;
    if (name.startsWith('__Host-')) {
        return { name, value, path: '/', secure: true, httpOnly, sameSite, url: CHATGPT_COOKIE_URL };
    }
    if (name.startsWith('__Secure-')) {
        return { name, value, domain: 'chatgpt.com', path: '/', secure: true, httpOnly, sameSite };
    }
    return null;
}

async function addCookieSafe(context, cookie) {
    try {
        await context.addCookies([cookie]);
        return null;
    } catch (primaryErr) {
        const fallback = toPlaywrightCookieFallback(cookie);
        if (!fallback) {
            return primaryErr.message;
        }
        try {
            await context.addCookies([fallback]);
            return null;
        } catch (fallbackErr) {
            return fallbackErr.message || primaryErr.message;
        }
    }
}

async function injectChatGptCookies(context, cookieSpecs) {
    if (!cookieSpecs.length) {
        return { injected: 0, hasSessionToken: false, failed: [] };
    }

    const warmup = await context.newPage();
    try {
        await warmup.goto(`${CHATGPT_COOKIE_URL}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 90000
        });
    } catch (_) { /* 代理慢时仍尝试写 Cookie */ }

    const playwrightCookies = cookieSpecs
        .map((spec) => toPlaywrightCookie(spec))
        .filter(Boolean);

    const failed = [];
    let injected = 0;
    for (const cookie of playwrightCookies) {
        const error = await addCookieSafe(context, cookie);
        if (error) {
            failed.push({ name: cookie.name, error });
            console.warn(`[Session] Cookie 注入跳过 ${cookie.name}: ${error}`);
            continue;
        }
        injected += 1;
    }

    if (failed.length) {
        console.warn(`[Session] ${failed.length}/${playwrightCookies.length} 个 Cookie 注入失败`);
    }

    const stored = await context.cookies(CHATGPT_COOKIE_URL);
    const hasSessionToken = hasStoredSessionToken(stored);
    await warmup.close().catch(() => {});

    return {
        injected,
        hasSessionToken,
        storedNames: stored.map((c) => c.name),
        failed
    };
}

// 将不同格式的 Session Cookie 转为后续浏览器注入所需的统一对象数组。
function collectCookieSpecs(sessionData, sessionJson) {
    // 保存最终结果；每项至少包含 Cookie 名称和 Cookie 值。
    const specs = [];
    // 保存“名称 + 值”的唯一标识，用于排除完全相同的 Cookie。
    const seen = new Set();
    // 单独保存名称，用于判断某个关键 Cookie 是否已存在。
    const seenNames = new Set();

    // 定义内部写入函数，统一完成清洗、去重和补充属性。
    const push = (name, value, extra = {}) => {
        // 将名称转为字符串并去除首尾空格；空值会变成空字符串。
        const n = String(name || '').trim();
        // 将值转为字符串并去除首尾空格；避免写入空 Cookie。
        const v = String(value || '').trim();
        // Cookie 名称或值为空时，该 Cookie 无法使用，直接跳过。
        if (!n || !v) return;
        // 使用空字符连接名称和值，生成不易冲突的去重键。
        const key = `${n}\0${v}`;
        // 已经收集过相同名称和值时，避免重复注入浏览器。
        if (seen.has(key)) return;
        // 记录本次 Cookie 的唯一键，供后续去重判断。
        seen.add(key);
        // 记录 Cookie 名称，供后续关键 Cookie 是否存在的判断使用。
        seenNames.add(n);
        // 将标准字段与额外属性合并后加入最终结果。
        specs.push({ name: n, value: v, ...extra });
    };

    // 依次尝试原始 JSON 和已解析 Session 中的完整 cookies 数组。
    for (const source of [sessionJson?.cookies, sessionData?.cookies]) {
        // 当前来源不是数组时无法遍历，跳到下一个来源。
        if (!Array.isArray(source)) continue;
        // 逐项读取来源中的完整 Cookie 对象。
        for (const item of source) {
            // 空值或非对象不是有效 Cookie 描述，直接跳过。
            if (!item || typeof item !== 'object') continue;
            // 提取并清洗 Cookie 名称。
            const name = String(item.name || '').trim();
            // 提取并清洗 Cookie 值。
            const value = String(item.value || '').trim();
            // 名称或值缺失的 Cookie 无法注入，直接跳过。
            if (!name || !value) continue;
            // 只接收 ChatGPT 域名的 Cookie，避免注入无关站点的数据。
            if (!isChatGptCookieDomain(item.domain)) continue;
            // 保留完整 Cookie 属性，使浏览器按原有作用域和安全策略写入。
            push(name, value, {
                // Cookie 生效的域名。
                domain: item.domain,
                // Cookie 生效的路径。
                path: item.path,
                // 是否仅允许 HTTPS 请求携带该 Cookie。
                secure: item.secure,
                // 是否禁止页面 JavaScript 直接读取该 Cookie。
                httpOnly: item.httpOnly,
                // 跨站请求时的携带策略。
                sameSite: item.sameSite,
                // 是否仅绑定当前主机而非所有子域名。
                hostOnly: item.hostOnly
            });
        }
    }

    // 依次读取 camelCase 与 snake_case 形式的 Cookie 请求头。
    for (const header of [
        sessionData?.cookieHeader,
        sessionData?.cookie_header,
        sessionJson?.cookieHeader,
        sessionJson?.cookie_header
    ]) {
        // 将“name=value; ...”请求头拆分为单个 Cookie 键值对。
        for (const pair of parseCookieHeader(header)) {
            // 请求头不含域名等属性，只写入名称和值。
            push(pair.name, pair.value);
        }
    }

    // 检查已收集的 Cookie 中是否已包含任意 session-token（包括分块名称）。
    const hasExportedSessionToken = [...seenNames].some((name) => isSessionTokenCookieName(name));

    // 按优先级从环境变量和 Session 字段读取会话令牌。
    const sessionToken = String(
        // 优先使用显式配置的完整 Session Cookie。
        process.env.CHATGPT_SESSION_COOKIE
        // 兼容旧环境变量名称。
        || process.env.CHATGPT_SESSION_TOKEN
        // 兼容 Session 中的 camelCase 字段。
        || sessionData?.sessionToken
        // 兼容 Session 中的 snake_case 字段。
        || sessionData?.session_token
        // 兼容直接以 Cookie 名为键保存的 Session 数据。
        || sessionData?.['__Secure-next-auth.session-token']
        // 所有来源都不存在时转为空字符串，便于统一调用 trim。
        || ''
    ).trim();

    // 只有拿到令牌且完整 Cookie 列表中尚未提供它时，才根据字段补齐。
    if (sessionToken && !hasExportedSessionToken) {
        // 将可能超长的 NextAuth 会话令牌拆成浏览器可识别的分块 Cookie。
        const chunks = expandSessionTokenCookies(sessionToken);
        // 多个分块意味着令牌长度超出单个 Cookie 的常见限制，记录诊断日志。
        if (chunks.length > 1) {
            console.log(`[Session] session-token 长度 ${sessionToken.length}，按 NextAuth 分 ${chunks.length} 块注入`);
        }
        // 逐个添加拆分后的 session-token Cookie。
        for (const chunk of chunks) {
            push(chunk.name, chunk.value);
        }
    }

    // 从 Session 的多种字段命名中读取 CSRF 令牌。
    const csrfToken = String(
        // 优先使用 camelCase 字段。
        sessionData?.csrfToken
        // 兼容 snake_case 字段。
        || sessionData?.csrf_token
        // 兼容以实际 Cookie 名为键保存的字段。
        || sessionData?.['__Host-next-auth.csrf-token']
        // 缺失时使用空字符串，避免 String(undefined) 变成字符串 "undefined"。
        || ''
    ).trim();
    // CSRF 令牌存在且尚未由 cookies 或请求头提供时，补齐对应 Cookie。
    if (csrfToken && !seenNames.has('__Host-next-auth.csrf-token')) {
        push('__Host-next-auth.csrf-token', csrfToken);
    }

    // 从 Session 的多种字段命名中读取 OpenAI 设备标识。
    const deviceId = String(sessionData?.deviceId || sessionData?.device_id || sessionData?.['oai-did'] || '').trim();
    // 设备标识存在且尚未收集时，补齐 oai-did Cookie。
    if (deviceId && !seenNames.has('oai-did')) {
        push('oai-did', deviceId);
    }

    // 返回已清洗、去重并补齐后的 Cookie 规格列表。
    return specs;
}

async function verifyRealSessionApi(context) {
    const probe = await context.newPage();
    try {
        const response = await probe.goto(`${CHATGPT_COOKIE_URL}/api/auth/session`, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        const status = response?.status() || 0;
        const headers = response?.headers?.() || {};
        const challengeHeader = String(headers['cf-mitigated'] || '').toLowerCase() === 'challenge';
        const bodyText = await probe.evaluate(() => document.body?.innerText || '').catch(() => '');
        let data = null;
        try {
            data = JSON.parse(bodyText);
        } catch (_) {
            data = null;
        }
        const sessionObject = data && typeof data === 'object' && !Array.isArray(data);
        // Session profile values may quote verification wording. Only an actual
        // challenge response, rather than text inside JSON, is a challenge page.
        const isCloudflareChallenge = challengeHeader
            || (!sessionObject && /just a moment|verify you are human/i.test(bodyText));
        if (isCloudflareChallenge) {
            return {
                ok: false,
                status,
                challenge: true,
                code: 'UPSTREAM_BLOCKED',
                error: `官网要求验证（HTTP ${status}），尚未确认登录状态`
            };
        }
        const hasSessionIdentity = sessionObject && data.error == null && data.errors == null
            && [data.accessToken, data.user?.email, data.user?.id]
                .some((value) => typeof value === 'string' && value.trim());
        if (status === 200 && hasSessionIdentity) {
            return { ok: true, data, status };
        }
        const emptySession = status === 200 && sessionObject && Object.keys(data).length === 0;
        return {
            ok: false,
            status,
            code: status === 401 || emptySession
                ? 'SESSION_INVALID' : status === 403 ? 'UPSTREAM_FORBIDDEN' : 'NETWORK_UNAVAILABLE',
            error: `登录状态尚未核实（HTTP ${status}）`
        };
    } catch (err) {
        return { ok: false, code: err.name === 'TimeoutError' ? 'NETWORK_TIMEOUT' : 'NETWORK_UNAVAILABLE',
            error: err.name === 'TimeoutError' ? '登录状态查询超时' : '登录状态查询网络失败' };
    } finally {
        await probe.close().catch(() => {});
    }
}

function verifiedSessionPayload(sessionData, accessToken, data) {
    const mismatch = () => {
        throw Object.assign(new Error('官网会话身份与原任务不一致，已停止后续操作'), { code: 'ACCOUNT_MISMATCH' });
    };
    const identity = (value) => {
        if (value == null || value === '') return '';
        if (typeof value !== 'string') mismatch();
        return value;
    };
    const agreed = (...values) => {
        const known = [...new Set(values.map(identity).filter(Boolean))];
        if (known.length > 1) mismatch();
        return known[0] || '';
    };
    const original = extractProfileFromToken(accessToken);
    const expectedAccount = agreed(original.accountId, sessionData.account?.id);
    const expectedUser = agreed(original.userId, sessionData.user?.id);
    const freshToken = typeof data.accessToken === 'string' ? data.accessToken.trim() : '';
    const refreshed = Boolean(freshToken && freshToken !== accessToken);
    const observed = extractProfileFromToken(freshToken || accessToken);
    const observedAccount = agreed(observed.accountId, data.account?.id);
    const observedUser = agreed(observed.userId, data.user?.id);
    if ((expectedAccount && observedAccount && expectedAccount !== observedAccount)
        || (expectedUser && observedUser && expectedUser !== observedUser)) mismatch();
    if (!refreshed) return sessionData;
    // Only the original task's known identity may authorize replacing its
    // bearer. A matching email or an unrelated user_id namespace is not proof.
    if ((!expectedAccount && !expectedUser)
        || (expectedAccount && identity(observed.accountId) !== expectedAccount)
        || (expectedUser && identity(observed.userId) !== expectedUser)) mismatch();
    const user = data.user && typeof data.user === 'object' && !Array.isArray(data.user)
        ? data.user : sessionData.user;
    const expires = typeof data.expires === 'string' && Number.isFinite(Date.parse(data.expires))
        ? data.expires : sessionData.expires;
    require('../security.cjs').rememberSecrets({ accessToken: freshToken });
    console.log('[Session] 已采用官网核实的同账号最新登录凭据');
    return buildSessionPayload(freshToken, {
        ...sessionData, user, expires, accessToken: freshToken,
        ...(Object.hasOwn(sessionData, 'access_token') ? { access_token: freshToken } : {})
    });
}

function extractAccessTokenFromRaw(raw) {
    const content = String(raw || '').trim();
    if (!content) {
        return '';
    }

    const sessionJson = parseSessionJson(content);
    if (sessionJson) {
        return String(sessionJson.accessToken || sessionJson.access_token || '').trim();
    }

    const jwtMatch = content.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (jwtMatch) {
        return jwtMatch[0];
    }

    return content;
}

/**
 * 统一解析用户输入：优先完整 Session JSON，其次裸 AccessToken
 */
function resolveSessionInput(raw) {
    const content = String(raw || '').trim();
    if (!content) {
        return null;
    }

    const sessionJson = parseSessionJson(content);
    if (sessionJson) {
        const accessToken = extractAccessTokenFromRaw(content);
        if (!accessToken) {
            return null;
        }
        return {
            accessToken,
            sessionJson,
            sessionData: buildSessionPayload(accessToken, sessionJson),
            rawJson: JSON.stringify(sessionJson)
        };
    }

    const accessToken = extractAccessTokenFromRaw(content);
    if (!accessToken) {
        return null;
    }

    const sessionData = buildSessionPayload(accessToken, null);
    return {
        accessToken,
        sessionJson: null,
        sessionData,
        rawJson: JSON.stringify(sessionData)
    };
}

async function assertChatGptLoggedIn(page, label = '页面', diagnostics = {}) {
    const url = page.url();
    if (isLoginRedirectUrl(url)) {
        throw sessionNotConfirmed(`尚未在${label}确认登录，已停止后续操作`,
            'login_redirect', { ...diagnostics, redirectDetected: true });
    }
    if (await hasVisibleLoginChrome(page)) {
        throw sessionNotConfirmed(`尚未在${label}确认登录，页面仍显示登录控件`,
            'visible_login_controls', { ...diagnostics, visibleLogin: true });
    }
    if (await isLoginPageContent(page)) {
        throw sessionNotConfirmed(`尚未在${label}确认登录，页面仍显示登录内容`,
            'visible_login_content', diagnostics);
    }
}

function attachLoginRedirectGuard(page, onLoginRedirect) {
    page.on('framenavigated', async (frame) => {
        if (frame !== page.mainFrame() || page.isClosed()) {
            return;
        }
        const url = frame.url();
        const current = page.url();
        if (isCheckoutPageUrl(current) || isCheckoutPageUrl(url)) {
            return;
        }
        if (isLoginRedirectUrl(url)) onLoginRedirect?.();
        if (!isHardLoginRedirectUrl(url)) {
            return;
        }
        console.warn('[Warn] 检测到登录页跳转，正在拉回 ChatGPT');
        await page.goto(`${CHATGPT_ORIGIN}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        }).catch(() => {});
    });
}

/**
 * 在浏览器上下文安装 Session：拦截 auth API + 注入 fetch 补丁
 * 注意：__Secure-next-auth.session-token 是加密 cookie，不能用 accessToken 冒充
 */
async function installChatGptSession(context, sessionRaw) {
    const resolved = resolveSessionInput(sessionRaw);
    if (!resolved?.accessToken) {
        throw new Error('缺少 Session：请粘贴完整 Session JSON（来自 chatgpt.com/api/auth/session）');
    }

    let token = resolved.accessToken;
    let sessionData = resolved.sessionData;
    const { sessionJson } = resolved;
    const cookieSpecs = collectCookieSpecs(sessionData, sessionJson);

    const sessionTokenValue = String(
        process.env.CHATGPT_SESSION_COOKIE
        || process.env.CHATGPT_SESSION_TOKEN
        || sessionData?.sessionToken
        || sessionData?.session_token
        || sessionData?.['__Secure-next-auth.session-token']
        || cookieSpecs.find((c) => c.name === SESSION_TOKEN_BASE)?.value
        || ''
    ).trim();

    if (sessionTokenValue && sessionTokenValue === token) {
        throw new Error(
            'sessionToken 与 accessToken 相同：请从浏览器 DevTools → Application → Cookies 复制 '
            + '__Secure-next-auth.session-token（不是 /api/auth/session JSON 里的 accessToken）'
        );
    }

    const injectResult = await injectChatGptCookies(context, cookieSpecs);

    const sessionTokenFailed = injectResult.failed?.filter((item) => isSessionTokenCookieName(item.name)) || [];

    if (sessionTokenValue && sessionTokenFailed.length) {
        throw new Error(
            `session-token Cookie 注入失败: ${sessionTokenFailed.map((item) => `${item.name}(${item.error})`).join('; ')}`
        );
    }

    if (!injectResult.hasSessionToken) {
        console.warn('[Session] 未提供 session-token Cookie，Checkout 会停留在登录页；'
            + '请导出 __Secure-next-auth.session-token，或粘贴完整 cookies[] / cookieHeader');
    } else {
        console.log(
            `[Session] 已注入 ${injectResult.injected} 个 Cookie（session-token ${sessionTokenValue ? `${sessionTokenValue.length} 字符` : '来自 cookies[]'}）`
        );
    }

    let cookieVerified = false;
    if (injectResult.hasSessionToken) {
        const apiCheck = await verifyRealSessionApi(context);
        if (apiCheck.ok) {
            sessionData = verifiedSessionPayload(sessionData, token, apiCheck.data);
            token = sessionData.accessToken;
            cookieVerified = true;
            const email = apiCheck.data?.user?.email || '';
            console.log(`[Session] Cookie 校验通过${email ? `: ${email}` : ''}`);
        } else if (apiCheck.code === 'SESSION_INVALID') {
            throw Object.assign(new Error(
                `${apiCheck.error}。请确认 Cookie 未过期，并尽量粘贴浏览器全部 chatgpt.com Cookies（cookies[] 或 cookieHeader）`
            ), { code: 'SESSION_INVALID' });
        } else {
            console.warn(`[Session] Cookie 在线校验跳过: ${apiCheck.error || 'unknown'}`);
        }
    }

    const sessionBody = JSON.stringify(sessionData);

    await context.addInitScript((payload) => {
        const officialUrl = (value) => {
            try {
                const url = new URL(value, window.location.href);
                return url.protocol === 'https:' && !url.port
                    && ['chatgpt.com', 'openai.com'].some((host) =>
                        url.hostname === host || url.hostname.endsWith(`.${host}`));
            } catch (_) { return false; }
        };
        if (!officialUrl(window.location.href)) return;
        const sessionStr = JSON.stringify(payload);
        try {
            window.__CHATGPT_BOOTSTRAP_SESSION__ = payload;
            localStorage.setItem('oai/apps/chat/bootstrap-session', sessionStr);
        } catch (_) { /* ignore */ }

        const originalFetch = window.fetch.bind(window);
        window.fetch = async function patchedFetch(input, init) {
            const raw = input && typeof input.url === 'string' ? input.url : String(input);
            let url;
            try { url = new URL(raw, window.location.href); } catch (_) { return originalFetch(input, init); }
            if (!officialUrl(url.href) || !['/api/auth/session', '/api/auth/csrf'].includes(url.pathname)) {
                return originalFetch(input, init);
            }
            // Preserve native validation (including GET bodies) and cancellation
            // before returning the read-only compatibility response.
            const request = new Request(input, init);
            if (request.method !== 'GET' || request.signal.aborted) return originalFetch(request);
            if (url.pathname === '/api/auth/session') {
                return new Response(sessionStr, {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (url.pathname === '/api/auth/csrf') {
                return new Response(JSON.stringify({ csrfToken: 'bootstrap-csrf-token' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            return originalFetch(input, init);
        };
    }, sessionData);

    await context.route(/\/api\/auth\/session(\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET' || !isOfficialSessionUrl(route.request().url())
            || new URL(route.request().url()).pathname !== '/api/auth/session') {
            await route.continue();
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: sessionBody
        });
    });

    await context.route(/\/api\/auth\/csrf(\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET' || !isOfficialSessionUrl(route.request().url())
            || new URL(route.request().url()).pathname !== '/api/auth/csrf') {
            await route.continue();
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ csrfToken: 'bootstrap-csrf-token' })
        });
    });

    await context.route('**/*', async (route) => {
        const url = route.request().url();
        const resourceType = route.request().resourceType();
        if (shouldBlockLoginNavigation(url, resourceType)) {
            await route.abort();
            return;
        }
        if (route.request().method() === 'GET' && isOfficialSessionUrl(url)
            && /^\/api\/auth\/(session|csrf)$/.test(new URL(url).pathname)) {
            // This last-registered route runs first. Continue would bypass the
            // dedicated official Session/CSRF handlers registered above.
            await route.fallback();
            return;
        }
        await route.continue();
    });

    return { sessionData, cookieVerified };
}

/**
 * @deprecated 使用 installChatGptSession(context, sessionRaw)
 */
function setupChatGptSessionAuth(context, accessToken) {
    return installChatGptSession(context, accessToken);
}

/**
 * 打开 ChatGPT 并验证 Session 在浏览器 UI 中生效
 */
async function bootstrapChatGptSession(page, sessionRaw, options = {}) {
    const signal = options.signal;
    const deadlineAt = Number.isFinite(options.deadlineAt) ? options.deadlineAt : performance.now() + 180000;
    const diagnostics = {
        reason: 'runtime_failed', authApiVerified: options.cookieVerified === true,
        visibleLogin: false, loggedInUi: false, redirectDetected: false,
        challengeDetected: false, pageClosed: false
    };
    const remaining = (cap) => {
        signal?.throwIfAborted();
        const value = Math.min(cap, Math.floor(deadlineAt - performance.now()));
        if (value <= 0) throw Object.assign(new Error('登录核验超时'), { code: 'NETWORK_TIMEOUT' });
        return value;
    };
    try {
        const resolved = resolveSessionInput(sessionRaw);
        if (!resolved?.accessToken) {
            throw sessionNotConfirmed('缺少 Session：请提供完整会话资料', 'input_missing', diagnostics);
        }

        const sessionData = options.sessionData || resolved.sessionData;
        const email = sessionData?.user?.email || extractProfileFromToken(resolved.accessToken).email || '';
        const cookieVerified = options.cookieVerified === true;
        let uiWaitRemaining = cookieVerified ? 12000 : 8000;
        let guestHomepageReloaded = false;
        const waitForStableUi = async (stopWhen) => {
            remaining(1);
            if (uiWaitRemaining <= 0) return false;
            const started = performance.now();
            try {
                return await waitForLoggedInChatUi(page, remaining(Math.max(1, Math.floor(uiWaitRemaining))),
                    { deadlineAt, signal, stopWhen });
            } finally {
                uiWaitRemaining = Math.max(0, uiWaitRemaining - (performance.now() - started));
            }
        };

        if (!email && !sessionData?.user?.id) {
            throw sessionNotConfirmed('会话资料缺少账号信息，尚未确认登录', 'identity_missing', diagnostics);
        }

        console.log('🔐 [步骤] 正在使用 Session 登录 ChatGPT...');
        attachLoginRedirectGuard(page, () => { diagnostics.redirectDetected = true; });

        diagnostics.reason = 'navigation_failed';
        await page.goto(`${CHATGPT_ORIGIN}/`, {
            waitUntil: 'domcontentloaded',
            timeout: remaining(90000)
        });
        await page.waitForTimeout(remaining(2500));

        diagnostics.reason = 'verification_failed';
        const { clearHumanVerification, isBlockingHumanVerificationVisible } = require('./human-verification');
        const isOfficialHomepage = () => {
            try {
                const url = new URL(page.url());
                return url.origin === CHATGPT_ORIGIN && url.pathname === '/'
                    && !url.username && !url.password;
            } catch (_) { return false; }
        };
        const assertCurrentLoggedInUi = async () => {
            let restabilized = false;
            for (;;) {
                remaining(1);
                if (!isOfficialHomepage())
                    throw sessionNotConfirmed('登录核验已离开原首页，已停止后续操作', 'navigation_failed', diagnostics);
                try {
                    await assertChatGptLoggedIn(page, '首页', diagnostics);
                    if (!isOfficialHomepage())
                        throw sessionNotConfirmed('登录核验已离开原首页，已停止后续操作', 'navigation_failed', diagnostics);
                    return restabilized;
                } catch (error) {
                    if (error.code !== 'SESSION_NOT_CONFIRMED'
                        || !['visible_login_controls', 'visible_login_content'].includes(error.bootstrapDiagnostics?.reason)
                        || !isOfficialHomepage() || uiWaitRemaining <= 0) throw error;
                    const challenge = await isBlockingHumanVerificationVisible(page);
                    diagnostics.challengeDetected ||= challenge;
                    if (challenge)
                        throw Object.assign(new Error('官网验证尚未完成，登录核验未完成'), { code: 'HUMAN_VERIFICATION_REQUIRED' });
                    diagnostics.reason = 'login_not_confirmed';
                    diagnostics.loggedInUi = await waitForStableUi(async () => {
                        const blocking = await isBlockingHumanVerificationVisible(page);
                        diagnostics.challengeDetected ||= blocking;
                        return blocking;
                    });
                    if (!isOfficialHomepage())
                        throw sessionNotConfirmed('登录核验已离开原首页，已停止后续操作', 'navigation_failed', diagnostics);
                    diagnostics.visibleLogin = await hasVisibleLoginChrome(page);
                    if (await isBlockingHumanVerificationVisible(page)) {
                        diagnostics.challengeDetected = true;
                        throw Object.assign(new Error('官网验证尚未完成，登录核验未完成'), { code: 'HUMAN_VERIFICATION_REQUIRED' });
                    }
                    if (!diagnostics.loggedInUi) {
                        await assertChatGptLoggedIn(page, '首页', diagnostics);
                        throw sessionNotConfirmed('尚未取得首页的稳定登录证据，已停止后续操作', 'login_not_confirmed', diagnostics);
                    }
                    restabilized = true;
                }
            }
        };
        const reloadGuestHomepageOnce = async () => {
            remaining(1);
            if (guestHomepageReloaded || page.isClosed?.() || !isOfficialHomepage()) return false;
            const challenge = await isBlockingHumanVerificationVisible(page);
            diagnostics.challengeDetected ||= challenge;
            if (challenge || !await hasVisibleLoginChrome(page)) return false;
            // A challenge may mount while the guest controls are being read.
            const challengeBeforeReload = await isBlockingHumanVerificationVisible(page);
            diagnostics.challengeDetected ||= challengeBeforeReload;
            remaining(1);
            if (challengeBeforeReload || !isOfficialHomepage()) return false;
            guestHomepageReloaded = true;
            diagnostics.reason = 'navigation_failed';
            let abortReload;
            try {
                await new Promise((resolve, reject) => {
                    abortReload = () => {
                        // This Page belongs to the current task. Closing it also
                        // stops a pending navigation when its lease is cancelled.
                        Promise.resolve().then(() => page.close()).catch(() => {});
                        reject(signal.reason);
                    };
                    signal?.addEventListener('abort', abortReload, { once: true });
                    if (signal?.aborted) { abortReload(); return; }
                    // Both outcomes remain observed after cancellation, so a
                    // delayed navigation cannot continue login or reject unhandled.
                    Promise.resolve().then(() => {
                        signal?.throwIfAborted();
                        return page.reload({ waitUntil: 'domcontentloaded', timeout: remaining(90000) });
                    }).then(resolve, reject);
                });
            } finally {
                if (abortReload) signal?.removeEventListener('abort', abortReload);
            }
            remaining(1);
            if (!isOfficialHomepage())
                throw sessionNotConfirmed('刷新后未在原首页确认登录，已停止后续操作', 'navigation_failed', diagnostics);
            await page.waitForTimeout(remaining(2000));
            remaining(1);
            const challengeAfterReload = await isBlockingHumanVerificationVisible(page);
            diagnostics.challengeDetected ||= challengeAfterReload;
            if (challengeAfterReload) {
                diagnostics.reason = 'verification_failed';
                throw Object.assign(new Error('官网验证尚未完成，登录核验未完成'), { code: 'HUMAN_VERIFICATION_REQUIRED' });
            }
            // The original guest hydration wait may be spent. Recheck this one
            // refreshed page with the same UI cap and original overall deadline.
            uiWaitRemaining = cookieVerified ? 12000 : 8000;
            diagnostics.reason = 'login_not_confirmed';
            return true;
        };
        diagnostics.challengeDetected = await isBlockingHumanVerificationVisible(page);
        diagnostics.visibleLogin = await hasVisibleLoginChrome(page);
        if (!diagnostics.challengeDetected && diagnostics.visibleLogin) {
            diagnostics.reason = 'login_not_confirmed';
            diagnostics.loggedInUi = await waitForStableUi(async () => {
                const challenge = await isBlockingHumanVerificationVisible(page);
                diagnostics.challengeDetected ||= challenge;
                return challenge;
            });
            diagnostics.visibleLogin = await hasVisibleLoginChrome(page);
            // Ordinary guest controls can outlive hydration. Let the one
            // verification result reach the frozen upstream reload transition.
            if (!diagnostics.visibleLogin && !await isBlockingHumanVerificationVisible(page))
                await assertChatGptLoggedIn(page, '首页', diagnostics);
        }
        diagnostics.reason = 'verification_failed';
        const blockingVerification = await isBlockingHumanVerificationVisible(page);
        diagnostics.challengeDetected ||= blockingVerification;
        if (options.manualVerification === true && blockingVerification)
            throw Object.assign(new Error('官网需要人工验证'), { code: 'HUMAN_VERIFICATION_REQUIRED' });
        const captchaResult = options.manualVerification === true ? { cleared: true } : await clearHumanVerification(page, {
            phase: 'session-bootstrap',
            maxWaitMs: remaining(Number(process.env.CAPTCHA_CLEAR_TIMEOUT_MS || 180000)),
            deadlineAt,
            signal,
            maxBypassRounds: 6
        });
        let recoveredGuestTransition = false;
        if (!captchaResult.cleared && captchaResult.code === 'SESSION_INVALID'
            && captchaResult.sessionRequired === true && isOfficialHomepage()
            && !await isBlockingHumanVerificationVisible(page)) {
            diagnostics.reason = 'login_not_confirmed';
            await reloadGuestHomepageOnce();
            diagnostics.loggedInUi = await waitForStableUi(async () => {
                const challenge = await isBlockingHumanVerificationVisible(page);
                diagnostics.challengeDetected ||= challenge;
                return challenge;
            });
            if (await isBlockingHumanVerificationVisible(page)) {
                diagnostics.reason = 'verification_failed';
                diagnostics.challengeDetected = true;
                throw Object.assign(new Error('官网验证尚未完成，登录核验未完成'), { code: 'HUMAN_VERIFICATION_REQUIRED' });
            }
            diagnostics.visibleLogin = await hasVisibleLoginChrome(page);
            await assertCurrentLoggedInUi();
            if (!diagnostics.loggedInUi)
                throw sessionNotConfirmed('尚未取得首页的稳定登录证据，已停止后续操作', 'login_not_confirmed', diagnostics);
            recoveredGuestTransition = true;
        }
        if (!captchaResult.cleared && !recoveredGuestTransition) {
            if (captchaResult.code === 'SESSION_INVALID' && captchaResult.sessionRequired === true
                && !isOfficialHomepage()) await assertChatGptLoggedIn(page, '首页', diagnostics);
            throw Object.assign(new Error('官网验证未通过，登录核验未完成'), {
                code: captchaResult.code || 'HUMAN_VERIFICATION_REQUIRED',
                diagnostics: captchaResult.diagnostics
            });
        }

        diagnostics.reason = 'login_not_confirmed';
        await reloadGuestHomepageOnce();
        let uiReady = await waitForStableUi();
        diagnostics.loggedInUi = uiReady;
        diagnostics.visibleLogin = await hasVisibleLoginChrome(page);
        uiReady = await assertCurrentLoggedInUi() || uiReady;

        const apiReady = cookieVerified ? await hasLoggedInSessionApi(page) : false;
        remaining(1);

        diagnostics.visibleLogin = await hasVisibleLoginChrome(page);
        uiReady = await assertCurrentLoggedInUi() || uiReady;
        if (await isBlockingHumanVerificationVisible(page)) {
            diagnostics.reason = 'verification_failed';
            diagnostics.challengeDetected = true;
            throw Object.assign(new Error('官网验证尚未完成，登录核验未完成'), { code: 'HUMAN_VERIFICATION_REQUIRED' });
        }
        if (!uiReady && (guestHomepageReloaded || !apiReady)) {
            throw sessionNotConfirmed('尚未取得首页的登录成功证据，已停止后续操作', 'login_not_confirmed', diagnostics);
        }
        if (!uiReady && apiReady) {
            console.log('[Session] 首页 UI 探针未命中，但 /api/auth/session 已确认登录，继续流程');
        }

        const resolvedEmail = sessionData?.user?.email || email || extractProfileFromToken(resolved.accessToken).email;
        console.log(`✅ [步骤] Session 登录成功: ${resolvedEmail}`);
        return {
            email: resolvedEmail,
            session: sessionData,
            hasSessionCookie: Boolean(
                process.env.CHATGPT_SESSION_COOKIE
                || process.env.CHATGPT_SESSION_TOKEN
                || sessionData.sessionToken
                || sessionData.session_token
                || sessionData['__Secure-next-auth.session-token']
                || (Array.isArray(sessionData.cookies) && sessionData.cookies.length > 0)
                || sessionData.cookieHeader
                || sessionData.cookie_header
            )
        };
    } catch (error) {
        diagnostics.pageClosed = page?.isClosed?.() === true;
        try { diagnostics.redirectDetected ||= isLoginRedirectUrl(page.url()); } catch (_) { /* closed page */ }
        const known = safeBootstrapDiagnostics(error.bootstrapDiagnostics);
        const reason = diagnostics.pageClosed ? 'page_closed' : known?.reason || diagnostics.reason;
        error.bootstrapDiagnostics = safeBootstrapDiagnostics({ ...diagnostics, ...known, reason });
        const details = String(error.name || '') + ' ' + String(error.message || '');
        const networkCodes = [error.networkCode, error.code, error.cause?.code];
        const timeout = networkCodes.includes('ETIMEDOUT') || /timeout|timed out|AbortError/i.test(details);
        const network = timeout || /net::ERR_[A-Z_]+/.test(details) || networkCodes.some((code) =>
            ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED',
                'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)
                || /^net::ERR_[A-Z_]+$/.test(String(code || '')));
        const preservedCode = ['SESSION_NOT_CONFIRMED', 'SESSION_BOOTSTRAP_FAILED', 'SESSION_INVALID',
            'ACCOUNT_MISMATCH', 'HUMAN_VERIFICATION_REQUIRED', 'NETWORK_TIMEOUT', 'NETWORK_UNAVAILABLE',
            'PROXY_UNAVAILABLE', 'UPSTREAM_BLOCKED', 'UPSTREAM_FORBIDDEN', 'LEASE_LOST'].includes(error.code)
            ? error.code : require('./verification-runtime').controlledVerificationCode(error.code, null);
        if (!preservedCode && !network) {
            error = Object.assign(new Error('登录页面核验未完成，已停止后续操作'), {
                code: 'SESSION_BOOTSTRAP_FAILED', bootstrapDiagnostics: error.bootstrapDiagnostics
            });
        }
        const code = preservedCode || (timeout ? 'NETWORK_TIMEOUT' : network ? 'NETWORK_UNAVAILABLE' : error.code);
        console.warn('[Session] 登录核验未完成', { code, bootstrapDiagnostics: error.bootstrapDiagnostics });
        throw error;
    }
}

function extractSessionPreview(raw) {
    const resolved = resolveSessionInput(raw);
    if (!resolved) {
        return String(raw || '').slice(0, 32);
    }
    const email = resolved.sessionData?.user?.email;
    if (email) {
        return email;
    }
    return `${resolved.accessToken.slice(0, 12)}...`;
}

function extractEmailFromSession(raw) {
    const resolved = resolveSessionInput(raw);
    if (!resolved) {
        return '';
    }
    return String(
        resolved.sessionData?.user?.email
        || resolved.sessionJson?.user?.email
        || extractProfileFromToken(resolved.accessToken).email
        || ''
    ).trim();
}

module.exports = {
    CHATGPT_ORIGIN,
    installChatGptSession,
    setupChatGptSessionAuth,
    bootstrapChatGptSession,
    assertChatGptLoggedIn,
    parseSessionJson,
    resolveSessionInput,
    extractAccessTokenFromRaw,
    extractProfileFromToken,
    extractSessionPreview,
    extractEmailFromSession,
    buildSessionPayload,
    safeBootstrapDiagnostics,
    isLoginRedirectUrl,
    isHardLoginRedirectUrl,
    isCheckoutPageUrl,
    isLoginPageContent
};
