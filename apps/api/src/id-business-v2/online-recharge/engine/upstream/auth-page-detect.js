'use strict';

/** 页面 URL / 登录态检测（无依赖，避免 session-auth ↔ human-verification 循环引用） */

const SESSION_COOKIE_HINT = '请粘贴完整 Session JSON（含 sessionToken 字段，超长会自动分块），或从浏览器导出 chatgpt.com 的 cookies[]（含 __Secure-next-auth.session-token.0/.1）';

function navigationUrl(value) {
    try {
        const url = new URL(String(value || ''));
        return ['https:', 'http:'].includes(url.protocol) ? url : null;
    } catch (_) { return null; }
}

function isHardLoginRedirectUrl(value) {
    const url = navigationUrl(value);
    if (!url) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (['accounts.google.com', 'login.microsoftonline.com'].includes(host)) return true;
    const officialHost = ['chatgpt.com', 'openai.com'].some((domain) =>
        host === domain || host.endsWith(`.${domain}`));
    // A return URL or quoted login path in query/fragment is not a redirect.
    return officialHost && /^\/(?:api\/)?auth\/(?:login|error|signin)(?:\/|$)/i.test(url.pathname);
}

function isLoginRedirectUrl(value) {
    const url = navigationUrl(value);
    return Boolean(url && (isHardLoginRedirectUrl(value)
        || url.hostname.toLowerCase().replace(/\.$/, '') === 'auth.openai.com'));
}

function isCheckoutPageUrl(value) {
    const url = navigationUrl(value);
    return Boolean(url && url.protocol === 'https:' && !url.port
        && url.hostname.toLowerCase().replace(/\.$/, '') === 'chatgpt.com'
        && /^\/checkout\//i.test(url.pathname));
}

function shouldBlockLoginNavigation(url, resourceType = '') {
    const parsed = navigationUrl(url);
    if (!parsed) return false;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (['accounts.google.com', 'login.microsoftonline.com'].includes(host)) return true;
    if (resourceType === 'document' && isHardLoginRedirectUrl(url) && !isCheckoutPageUrl(url)) {
        return true;
    }
    return false;
}

async function isLoginPageContent(page) {
    try {
        return await renderedAuthCandidate(page.locator(
            'h1,h2,h3,h4,h5,h6,[role="heading"],form,[role="dialog"],dialog,button,a,[role="button"],[role="link"]'
        ), { loginContent: true, excludeConversation: true });
    } catch (error) {
        throw loginReadFailure(error, 'login_content');
    }
}

function loginReadFailure(error, probe) {
    if (['LEASE_LOST', 'VERIFICATION_CANCELLED', 'VERIFICATION_TIMEOUT', 'CHECKOUT_AUTH_READ_FAILED'].includes(error.code)) return error;
    return Object.assign(new Error('登录页面读取失败'), { code: 'CHECKOUT_AUTH_READ_FAILED', readClass: 'read_failed', probe });
}

async function renderedAuthCandidate(locator, options = {}) {
    return locator.evaluateAll((nodes, options) => {
        const conversation = '[data-message-author-role],[data-testid^="conversation-turn"],article';
        const parent = (node) => node.parentElement || node.getRootNode?.().host || null;
        const semanticVisible = (node) => {
            if (!(node instanceof Element)) return false;
            const visibility = getComputedStyle(node).visibility;
            if (visibility === 'hidden' || visibility === 'collapse') return false;
            for (let current = node; current; current = parent(current)) {
                const style = getComputedStyle(current);
                if (current.hidden || current.inert || current.hasAttribute('inert')
                    || current.getAttribute('aria-hidden')?.toLowerCase() === 'true'
                    || style.display === 'none' || Number.parseFloat(style.opacity) === 0
                    || style.contentVisibility === 'hidden') return false;
            }
            return true;
        };
        const hasArea = (rects) => [...rects].some((rect) => rect.width > 0 && rect.height > 0);
        const visibleText = (root) => {
            const parts = [];
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                const element = text.parentElement;
                if (!element || element.closest('script,style,template,noscript,textarea')
                    || (options.excludeConversation && element.closest(conversation))
                    || !semanticVisible(element)) continue;
                const range = document.createRange();
                range.selectNodeContents(text);
                if (hasArea(range.getClientRects())) parts.push(text.textContent || '');
                range.detach();
            }
            return parts.join(' ').replace(/\s+/g, ' ').trim();
        };
        return nodes.some((node) => {
            if (!semanticVisible(node)) return false;
            if (options.excludeConversation && node.closest(conversation)) return false;
            if (!options.loginContent) return hasArea(node.getClientRects());
            // Ordinary messages and the chat composer can quote login wording.
            // Only a rendered authentication group or action is a login gate.
            if (node.matches('form') && node.querySelector(
                'textarea#prompt-textarea,textarea[placeholder*="Ask"],[contenteditable="true"]'
            )) return false;
            const text = visibleText(node);
            return /Sign in with Google/i.test(text)
                || /Sign in to continue/i.test(text)
                || /Log in to continue/i.test(text)
                || /to continue to OpenAI/i.test(text)
                || /登录\s*ChatGPT/i.test(text)
                || /使用\s*Google\s*登录/i.test(text)
                || (/\bLog in\b/i.test(text) && /\bSign up\b/i.test(text));
        });
    }, options);
}

/** 未登录访客 UI：仅检测可见的 Log in / Sign up 控件，不用 body 全文（已登录页 HTML 里也可能含这些词） */
async function readLoginProbe(label, locator, options) {
    const operation = () => renderedAuthCandidate(locator(), { excludeConversation: true });
    if (typeof options.readProbe !== 'function') return operation().catch(error => {
        if (['LEASE_LOST', 'VERIFICATION_CANCELLED', 'VERIFICATION_TIMEOUT'].includes(error.code)) throw error;
        throw Object.assign(new Error('登录控件读取失败'), { code: 'CHECKOUT_AUTH_READ_FAILED', readClass: 'read_failed', probe: label });
    });
    return options.readProbe(label, operation);
}

async function hasVisibleLoginChrome(page, options = {}) {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
        return false;
    }
    const probes = [
        () => page.getByRole('button', { name: /^Log in$/i }),
        () => page.getByRole('link', { name: /^Log in$/i }),
        () => page.getByRole('button', { name: /^Sign up for free$/i }),
        () => page.getByRole('link', { name: /^Sign up for free$/i }),
        () => page.getByText(/^Sign up for free$/i),
        () => page.getByText(/Get responses tailored to you/i)
    ];
    for (const [index, probe] of probes.entries()) {
        const label = ['login_button', 'login_link', 'signup_button', 'signup_link', 'signup_text', 'tailored_text'][index];
        if (await readLoginProbe(label, probe, options)) {
            return true;
        }
    }
    return false;
}

async function hasLoggedInChatUi(page) {
    if (await hasVisibleLoginChrome(page)) {
        return false;
    }
    const probes = [
        () => page.getByRole('button', { name: /^New chat$/i }),
        () => page.getByText(/Ready when you are/i),
        () => page.getByText(/Ask anything/i),
        () => page.locator('textarea[placeholder*="Ask"], textarea#prompt-textarea, div[contenteditable="true"]'),
        () => page.getByRole('navigation'),
        () => page.getByText(/Configure your plan/i),
        () => page.getByText(/^Card number$/i),
        () => page.getByText(/Due today/i)
    ];
    for (const probe of probes) {
        if (await renderedAuthCandidate(probe()).catch(error => { throw loginReadFailure(error, 'logged_in_ui'); })) {
            return true;
        }
    }
    return false;
}

/** 等待首页 hydration 稳定；访客内容消失后连续两轮核实已登录 UI。 */
async function waitForLoggedInChatUi(page, timeoutMs = 15000, options = {}) {
    const deadline = Math.min(performance.now() + timeoutMs,
        Number.isFinite(options.deadlineAt) ? options.deadlineAt : Infinity);
    let stable = 0;
    while (performance.now() < deadline) {
        options.signal?.throwIfAborted();
        if (await options.stopWhen?.()) return false;
        const ready = !isLoginRedirectUrl(page.url())
            && !await hasVisibleLoginChrome(page)
            && !await isLoginPageContent(page)
            && await hasLoggedInChatUi(page);
        stable = ready ? stable + 1 : 0;
        options.signal?.throwIfAborted();
        if (stable >= 2 && performance.now() < deadline) return true;
        const remaining = Math.min(500, Math.floor(deadline - performance.now()));
        if (remaining <= 0) break;
        await page.waitForTimeout(remaining);
    }
    options.signal?.throwIfAborted();
    return false;
}

async function hasLoggedInSessionApi(page, { timeoutMs = 8000 } = {}) {
    try {
        const data = await page.evaluate(async (timeoutMs) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetch('/api/auth/session', { credentials: 'include', signal: controller.signal });
                return await response.json();
            } finally { clearTimeout(timer); }
        }, Math.max(1, Math.min(8000, timeoutMs)));
        return Boolean(data?.accessToken || data?.user?.email || data?.user?.id);
    } catch (_) {
        return false;
    }
}

// Native read on the current page. The body stays transient with the caller;
// diagnostics must use sessionProbeFacts, never persist this return value.
async function readSessionApi(page, { timeoutMs = 8000 } = {}) {
    try {
        return await page.evaluate(async timeout => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);
            try {
                const response = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store', signal: controller.signal });
                return { status: response.status, text: await response.text(), headers: {
                    'content-type': response.headers.get('content-type'),
                    'cf-mitigated': response.headers.get('cf-mitigated'),
                    'cf-ray': response.headers.has('cf-ray') ? 'present' : ''
                } };
            } catch (error) {
                return { state: error.name === 'AbortError' ? 'timeout' : 'network_error' };
            } finally { clearTimeout(timer); }
        }, Math.max(1, Math.min(8000, timeoutMs)));
    } catch (_) { return { state: 'network_error' }; }
}

async function isCheckoutLoginGate(page, options = {}) {
    if (!isCheckoutPageUrl(page.url())) {
        return false;
    }
    if (await hasVisibleLoginChrome(page, options)) {
        return true;
    }
    return readLoginProbe('login_text',
        () => page.getByText(/Sign in to continue|Log in to continue|登录后继续/i), options);
}

function buildSessionNotLoggedInError(contextLabel = '页面') {
    return `Session 未在${contextLabel}生效（仍显示 Log in 访客界面）。${SESSION_COOKIE_HINT}`;
}

module.exports = {
    readSessionApi,
    SESSION_COOKIE_HINT,
    isLoginRedirectUrl,
    isHardLoginRedirectUrl,
    isCheckoutPageUrl,
    shouldBlockLoginNavigation,
    isLoginPageContent,
    hasVisibleLoginChrome,
    hasLoggedInChatUi,
    waitForLoggedInChatUi,
    hasLoggedInSessionApi,
    isCheckoutLoginGate,
    buildSessionNotLoggedInError
};
