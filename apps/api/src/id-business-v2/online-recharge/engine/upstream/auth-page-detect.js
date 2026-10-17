'use strict';

/** 页面 URL / 登录态检测（无依赖，避免 session-auth ↔ human-verification 循环引用） */

const SESSION_COOKIE_HINT = '请粘贴完整 Session JSON（含 sessionToken 字段，超长会自动分块），或从浏览器导出 chatgpt.com 的 cookies[]（含 __Secure-next-auth.session-token.0/.1）';

function isHardLoginRedirectUrl(url) {
    const value = String(url || '').toLowerCase();
    return value.includes('accounts.google.com')
        || value.includes('login.microsoftonline.com')
        || value.includes('/auth/login')
        || value.includes('/auth/error')
        || value.includes('/auth/signin');
}

function isLoginRedirectUrl(url) {
    const value = String(url || '').toLowerCase();
    return isHardLoginRedirectUrl(url) || value.includes('auth.openai.com');
}

function isCheckoutPageUrl(url) {
    return /chatgpt\.com\/checkout\//i.test(String(url || ''));
}

function shouldBlockLoginNavigation(url, resourceType = '') {
    const value = String(url || '').toLowerCase();
    if (value.includes('accounts.google.com') || value.includes('login.microsoftonline.com')) {
        return true;
    }
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
    } catch (_) {
        return false;
    }
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
async function hasVisibleLoginChrome(page) {
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
    for (const probe of probes) {
        if (await renderedAuthCandidate(probe(), { excludeConversation: true }).catch(() => false)) {
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
        if (await renderedAuthCandidate(probe()).catch(() => false)) {
            return true;
        }
    }
    return false;
}

/** 等待已登录 UI 出现（首页 hydration 可能较慢） */
async function waitForLoggedInChatUi(page, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await hasLoggedInChatUi(page)) {
            return true;
        }
        await page.waitForTimeout(500);
    }
    return false;
}

async function hasLoggedInSessionApi(page) {
    try {
        const data = await page.evaluate(async () => {
            const response = await fetch('/api/auth/session', { credentials: 'include' });
            return response.json();
        });
        return Boolean(data?.accessToken || data?.user?.email || data?.user?.id);
    } catch (_) {
        return false;
    }
}

async function isCheckoutLoginGate(page) {
    if (!isCheckoutPageUrl(page.url())) {
        return false;
    }
    if (await hasVisibleLoginChrome(page)) {
        return true;
    }
    try {
        return await renderedAuthCandidate(page.getByText(/Sign in to continue|Log in to continue|登录后继续/i),
            { excludeConversation: true });
    } catch (_) {
        return false;
    }
}

function buildSessionNotLoggedInError(contextLabel = '页面') {
    return `Session 未在${contextLabel}生效（仍显示 Log in 访客界面）。${SESSION_COOKIE_HINT}`;
}

module.exports = {
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
