/**
 * 人机验证统一处理：Cloudflare Turnstile / hCaptcha / Stripe challenge
 */

const { solveHcaptchaOnPage, isHcaptchaSolverEnabled } = require('./hcaptcha-solver');
const {
    isCaptchaPlatformEnabled,
    extractHcaptchaParamsFromPage,
    solveHcaptchaViaPlatform,
    injectHcaptchaTokenOnPage
} = require('./captcha-platform');
const { isLoginPageContent, isHardLoginRedirectUrl, isCheckoutPageUrl, hasVisibleLoginChrome, isCheckoutLoginGate, buildSessionNotLoggedInError } = require('./auth-page-detect');
const {
    createVerificationBudget, isCheckboxInstruction, inspectCaptchaFrames,
    prepareVerificationPage, disposeVerificationPage, verificationState,
    controlledVerificationCode, safeVerificationDiagnostics
} = require('./verification-runtime');

const BLOCKING_TEXT_PATTERNS = [
    /one more step before you'?re done/i,
    /select the checkbox below/i,
    /verify you are human/i,
    /are you a human/i,
    /i am human/i,
    /cf-turnstile/i,
    /cloudflare security check/i,
    /protected by hcaptcha/i,
    /performing security verification/i,
    /just a moment/i,
    /checking your browser/i,
    /完成验证/i,
    /人机验证/i,
    /请勾选/i
];

/** @deprecated 仅保留兼容；请用 isBlockingHumanVerificationVisible */
const CAPTCHA_CHALLENGE_PATTERNS = BLOCKING_TEXT_PATTERNS;

function captchaLog(phase, message, level = 'info') {
    const tag = level === 'warn' ? 'WARN' : level === 'error' ? 'ERROR' : 'INFO';
    const line = `[Captcha/${phase}][${tag}] ${message}`;
    console.log(`CAPTCHA_LOG: ${line}`);
}

function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isInvisibleStripeHcaptchaUrl(url) {
    const u = String(url || '').toLowerCase();
    if (!u) {
        return false;
    }
    if (u.includes('hcaptcha-invisible') || u.includes('hcaptchainvisible')) {
        return true;
    }
    if (u.includes('stripecdn.com') && u.includes('hcaptcha')) {
        return true;
    }
    if (u.includes('js.stripe.com') && u.includes('hcaptcha')) {
        return true;
    }
    return false;
}

function isBlockingCaptchaFrameUrl(url) {
    if (isInvisibleStripeHcaptchaUrl(url)) {
        return false;
    }
    const u = String(url || '').toLowerCase();
    if (u.includes('frame=challenge') || u.includes('frame=checkbox')) {
        return true;
    }
    return u.includes('challenges.cloudflare')
        || u.includes('turnstile')
        || u.includes('cloudflare.com/cdn-cgi');
}

function isCaptchaFrameUrl(url) {
    return isBlockingCaptchaFrameUrl(url) || isInvisibleStripeHcaptchaUrl(url);
}

function isHcaptchaCheckboxFrameUrl(url) {
    return String(url || '').toLowerCase().includes('frame=checkbox');
}

function isHcaptchaChallengeFrameUrl(url) {
    return String(url || '').toLowerCase().includes('frame=challenge');
}

async function hasHcaptchaImageChallenge(page) {
    return (await inspectCaptchaFrames(page)).some((item) => item.raster
        && item.prompts.some((prompt) => !isCheckboxInstruction(prompt)));
}

async function hasHcaptchaSolverTarget(page) {
    return await hasHcaptchaImageChallenge(page);
}

async function waitForPassiveCheckboxClear(page, phase, verifyOpts, timeoutMs = 45000) {
    captchaLog(phase, `仅 checkbox 验证，等待被动通过（最长 ${Math.round(timeoutMs / 1000)}s）...`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await clickHcaptchaCheckboxFrames(page, `${phase}-passive`);
        if (await isVerificationCleared(page, verifyOpts)) {
            captchaLog(phase, 'checkbox 被动验证已通过');
            return true;
        }
        await page.waitForTimeout(1200);
    }
    return false;
}

async function logCaptchaFrameSnapshot(page, phase) {
    const urls = page.frames()
        .map((frame) => frame.url() || '')
        .filter((url) => isBlockingCaptchaFrameUrl(url));
    const invisible = page.frames()
        .map((frame) => frame.url() || '')
        .filter((url) => isInvisibleStripeHcaptchaUrl(url));
    if (invisible.length > 0) {
        captchaLog(phase, `Stripe 隐形 hCaptcha 帧 ${invisible.length} 个（已忽略，非可见验证）`);
    }
    if (urls.length > 0) {
        captchaLog(phase, `可见拦截 frames: ${urls.map((url) => url.slice(0, 90)).join(' | ')}`);
    }
}

async function clickHcaptchaCheckboxFrames(page, phase = 'hcaptcha-checkbox', budget = null) {
    const frames = (await inspectCaptchaFrames(page)).filter((item) =>
        ['checkbox', 'turnstile'].includes(item.kind) && !item.checked && item.checkboxCount === 1);
    if (frames.length !== 1) return false;
    const checkbox = frames[0].frame.locator(':is(#checkbox, #anchor, [role="checkbox"], input[type="checkbox"]):visible');
    if (await checkbox.count() !== 1) return false;
    budget?.assert();
    await checkbox.click({ timeout: budget ? budget.timeout(2000) : 2000 });
    captchaLog(phase, '已操作唯一可见的验证复选框');
    return true;
}

async function waitForHcaptchaSolverTarget(page, phase, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await hasHcaptchaSolverTarget(page)) {
            return true;
        }
        await clickHcaptchaCheckboxFrames(page, `${phase}-warmup`);
        await page.waitForTimeout(900);
    }
    return false;
}

const CHECKOUT_CAPTCHA_TEXT_RE = /one more step|select the checkbox below|i am human|are you a human/i;

/** 从 body / 可见节点判断 Checkout hCaptcha 弹层 */
async function hasCheckoutCaptchaOverlayText(page) {
    if (!/checkout/i.test(page.url() || '')) {
        return false;
    }
    try {
        return await page.evaluate(() => {
            const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
            const captchaRe = /one more step|select the checkbox below|i am human|are you a human/i;
            const body = normalize(document.body?.innerText);
            if (captchaRe.test(body)) {
                return true;
            }
            const nodes = document.querySelectorAll('div, p, span, h1, h2, h3, [role="dialog"], section, article');
            for (const el of nodes) {
                if (!(el instanceof HTMLElement)) continue;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                    continue;
                }
                const rect = el.getBoundingClientRect();
                if (rect.width < 8 || rect.height < 8) continue;
                const text = normalize(el.innerText);
                if (!text || text.length > 320) continue;
                if (captchaRe.test(text)) {
                    return true;
                }
            }
            const iframes = document.querySelectorAll('iframe');
            for (const iframe of iframes) {
                const src = String(iframe.getAttribute('src') || '').toLowerCase();
                const title = String(iframe.getAttribute('title') || '').toLowerCase();
                if (!src.includes('hcaptcha') && !title.includes('hcaptcha')) continue;
                if (src.includes('hcaptcha-invisible') || src.includes('hcaptchainvisible')) continue;
                const rect = iframe.getBoundingClientRect();
                if (rect.width > 40 && rect.height > 20) {
                    return true;
                }
            }
            return false;
        });
    } catch (_) {
        return false;
    }
}

async function hasVisiblePostSubmitHcaptchaWidget(page) {
    if (!/checkout/i.test(page.url() || '')) return false;
    return (await inspectCaptchaFrames(page)).some((item) =>
        item.kind === 'challenge' || item.raster || !item.checked);
}

async function hasAnyCheckoutCaptchaSignal(page) {
    if (!/checkout/i.test(page.url() || '')) {
        return false;
    }
    if (await hasCheckoutCaptchaOverlayText(page)) {
        return true;
    }
    if (await hasVisiblePostSubmitHcaptchaWidget(page)) {
        return true;
    }
    for (const re of [/one more step/i, /select the checkbox/i, /i am human/i]) {
        try {
            if (await page.getByText(re).first().isVisible({ timeout: 300 })) {
                return true;
            }
        } catch (_) { /* next */ }
    }
    return false;
}

async function waitForCheckoutOverlayCaptcha(page, timeoutMs = 45000, options = {}) {
    const budget = createVerificationBudget({ ...options, maxWaitMs: timeoutMs });
    try {
        while (budget.remaining() > 0) {
            if (await budget.run(hasAnyCheckoutCaptchaSignal(page))) return true;
            await budget.wait(500);
        }
        return false;
    } catch (error) {
        if (error.code === 'VERIFICATION_TIMEOUT') return false;
        throw error;
    } finally { budget.dispose(); }
}

/** Checkout 上「One more step」hCaptcha 弹层 */
async function isCheckoutOverlayCaptchaVisible(page) {
    if (!(await hasAnyCheckoutCaptchaSignal(page))) {
        return false;
    }
    return true;
}

async function isBlockingHumanVerificationVisible(page) {
    if (await isCheckoutOverlayCaptchaVisible(page)) {
        return true;
    }

    const textPatterns = [
        /one more step/i,
        /select the checkbox below/i,
        /i am human/i,
        /are you a human/i,
        /verify you are human/i,
        /performing security verification/i,
        /just a moment/i,
        /checking your browser/i
    ];
    for (const re of textPatterns) {
        try {
            if (await page.getByText(re).first().isVisible({ timeout: 400 })) {
                return true;
            }
        } catch (_) { /* next */ }
    }

    const bodyText = String(await page.textContent('body', { timeout: 3000 }).catch(() => '') || '');
    if (/one more step|select the checkbox below|i am human/i.test(bodyText)) {
        return true;
    }
    if (BLOCKING_TEXT_PATTERNS.some((re) => re.test(bodyText))) {
        return true;
    }

    const captchaSelectors = [
        'iframe[src*="hcaptcha.com"][src*="frame=checkbox"]',
        'iframe[src*="hcaptcha.com"][src*="frame=challenge"]',
        'div:has-text("One more step") iframe',
        'div:has-text("I am human") iframe',
        'iframe[src*="challenges.cloudflare"]',
        'iframe[src*="turnstile"]',
        'iframe[title*="Cloudflare" i]',
        '.cf-turnstile',
        '#challenge-running',
        '#challenge-stage',
        'div:has-text("Verify you are human") iframe'
    ];
    for (const sel of captchaSelectors) {
        try {
            if (await page.locator(sel).first().isVisible({ timeout: 400 })) {
                return true;
            }
        } catch (_) { /* next */ }
    }

    for (const item of await inspectCaptchaFrames(page)) {
        if (item.raster || !item.checked) return true;
    }

    // 支付表单在弹层背后仍可见 — 不能据此判定「无验证」
    if (/checkout/i.test(page.url() || '')) {
        return false;
    }

    if (await isCheckoutPaymentReady(page)) {
        return false;
    }

    if (/configure your plan|card number|due today|subscribe now|billing address/i.test(bodyText)) {
        return false;
    }
    return false;
}

async function isHumanVerificationVisible(page) {
    return isBlockingHumanVerificationVisible(page);
}

/** Cloudflare 全页拦截（OpenAI logo + Verify you are human） */
async function isCloudflareWallPage(page) {
    try {
        const info = await page.evaluate(() => {
            const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
            const lower = text.toLowerCase();
            const hasVerify = lower.includes('verify you are human')
                || lower.includes('i am human')
                || lower.includes('select the checkbox');
            const hasCfBrand = lower.includes('cloudflare');
            const hasCheckoutUi = /card number|configure your plan|subscribe|billing address|支付|订阅/i.test(text);
            const hasChallengeEl = Boolean(
                document.querySelector(
                    'iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"], .cf-turnstile, #challenge-running, #challenge-stage, [id*="turnstile"]'
                )
            );
            return { hasVerify, hasCfBrand, hasCheckoutUi, hasChallengeEl, textSample: text.slice(0, 280) };
        });
        if (info.hasChallengeEl) {
            return true;
        }
        if (info.hasVerify && !info.hasCheckoutUi) {
            return true;
        }
        if (info.hasVerify && info.hasCfBrand) {
            return true;
        }
    } catch (_) { /* ignore */ }
    return false;
}

/** The same semantic controls decide readiness and perform the eventual fill. */
async function isCheckoutPaymentReady(page, options = {}) {
    const form = require('../checkout-form.cjs');
    if (await form.checkoutPageLoadFailed(page)) return false;
    const result = await form.inspectCardReadiness(page, {
        deadline: options.deadline || Date.now() + 2000,
        signal: options.signal
    });
    return result.ready;
}

async function waitForCheckoutPaymentReady(page, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isCheckoutLoginGate(page) || await hasVisibleLoginChrome(page)) {
            return 'login_required';
        }
        const url = page.url() || '';
        if (isHardLoginRedirectUrl(url) && !isCheckoutPageUrl(url)) {
            return 'login_redirect';
        }
        if (await isCheckoutPaymentReady(page, { deadline: Math.min(deadline, Date.now() + 2000) })) {
            return true;
        }
        await page.waitForTimeout(800);
    }
    if (await isCheckoutLoginGate(page) || await hasVisibleLoginChrome(page)) {
        return 'login_required';
    }
    return false;
}

async function isVerificationCleared(page, options = {}) {
    const pageUrl = page.url() || '';
    if (/redirect_status=succeeded/i.test(pageUrl) || /checkout\/verify/i.test(pageUrl)) {
        return true;
    }

    const requireCheckoutReady = options.requireCheckoutReady
        ?? /checkout/i.test(pageUrl);

    if (await hasAnyCheckoutCaptchaSignal(page)) {
        return false;
    }
    if (await isCheckoutOverlayCaptchaVisible(page)) {
        return false;
    }

    if (requireCheckoutReady && await isCheckoutPaymentReady(page)) {
        return true;
    }

    if (await isBlockingHumanVerificationVisible(page)) {
        return false;
    }
    if (await isCloudflareWallPage(page)) {
        return false;
    }
    if (requireCheckoutReady) {
        return await isCheckoutPaymentReady(page);
    }
    return true;
}

async function isPageBlocked(page, options = {}) {
    return !(await isVerificationCleared(page, options));
}

async function humanPause(page, minMs = 80, maxMs = 220) {
    await page.waitForTimeout(randomBetween(minMs, maxMs));
}

async function humanMouseMove(page, targetX, targetY) {
    const startX = targetX + randomBetween(-100, 100);
    const startY = targetY + randomBetween(-70, 70);
    const steps = randomBetween(14, 24);
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const ease = 1 - Math.pow(1 - t, 3);
        const x = startX + (targetX - startX) * ease + randomBetween(-2, 2);
        const y = startY + (targetY - startY) * ease + randomBetween(-2, 2);
        await page.mouse.move(x, y);
        await page.waitForTimeout(randomBetween(6, 22));
    }
}

async function humanClickAt(page, x, y) {
    const jitterX = x + randomBetween(-4, 4);
    const jitterY = y + randomBetween(-4, 4);
    await humanMouseMove(page, jitterX, jitterY);
    await humanPause(page, 50, 160);
    await page.mouse.down();
    await humanPause(page, 35, 110);
    await page.mouse.up();
}

async function humanClickBoundingBox(page, box, profile = 'center') {
    if (!box || box.width <= 0 || box.height <= 0) {
        return false;
    }
    let x;
    let y;
    if (profile === 'checkbox-left') {
        x = box.x + Math.min(38, box.width * 0.2) + randomBetween(-2, 3);
        y = box.y + box.height / 2 + randomBetween(-5, 5);
    } else if (profile === 'modal-below-text') {
        x = box.x + box.width / 2 + randomBetween(-20, 20);
        y = box.y + box.height * 0.72 + randomBetween(-8, 8);
    } else {
        x = box.x + box.width / 2 + randomBetween(-6, 6);
        y = box.y + box.height / 2 + randomBetween(-5, 5);
    }
    await humanClickAt(page, x, y);
    return true;
}

async function humanClickLocator(page, locator, profile = 'center') {
    try {
        await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        const box = await locator.boundingBox({ timeout: 2000 });
        return humanClickBoundingBox(page, box, profile);
    } catch (_) {
        return false;
    }
}

async function collectCaptchaIframeLocators(page) {
    const selectors = [
        'div:has-text("One more step") iframe',
        'div:has-text("I am human") iframe',
        'div:has-text("Verify you are human") iframe',
        'div:has-text("Select the checkbox") iframe',
        'iframe[src*="hcaptcha.com"][src*="frame=checkbox"]',
        'iframe[src*="hcaptcha.com"][src*="frame=challenge"]',
        'iframe[src*="challenges.cloudflare.com"]',
        'iframe[src*="turnstile"]',
        'iframe[title*="Cloudflare" i]',
        '.cf-turnstile iframe'
    ];
    const seen = new Set();
    const locators = [];

    for (const sel of selectors) {
        try {
            const items = page.locator(sel);
            const count = await items.count().catch(() => 0);
            for (let i = 0; i < count; i++) {
                const item = items.nth(i);
                const visible = await item.isVisible({ timeout: 400 }).catch(() => false);
                if (!visible) continue;
                const src = await item.getAttribute('src').catch(() => '') || '';
                if (isInvisibleStripeHcaptchaUrl(src)) continue;
                const title = await item.getAttribute('title').catch(() => '') || '';
                const key = `${sel}::${src}::${title}::${i}`;
                if (seen.has(key)) continue;
                seen.add(key);
                locators.push(item);
            }
        } catch (_) { /* next */ }
    }

    try {
        const allIframes = page.locator('iframe');
        const count = await allIframes.count().catch(() => 0);
        for (let i = 0; i < count; i += 1) {
            const item = allIframes.nth(i);
            if (!(await item.isVisible({ timeout: 300 }).catch(() => false))) continue;
            const src = await item.getAttribute('src').catch(() => '') || '';
            const title = await item.getAttribute('title').catch(() => '') || '';
            if (isInvisibleStripeHcaptchaUrl(src)) continue;
            if (!isBlockingCaptchaFrameUrl(src)
                && !/cloudflare|turnstile|hcaptcha|verify you are human/i.test(`${title} ${src}`)) continue;
            const key = `all::${src}::${title}::${i}`;
            if (seen.has(key)) continue;
            seen.add(key);
            locators.push(item);
        }
    } catch (_) { /* ignore */ }

    return locators;
}

async function dispatchSyntheticClickInFrame(frame) {
    return frame.evaluate(() => {
        const pickTarget = () => {
            const selectors = [
                'input[type="checkbox"]',
                'label.ctp-checkbox-label',
                'label',
                '#challenge-stage',
                '[role="checkbox"]',
                '.mark',
                'span',
                'body'
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) return el;
            }
            return document.body;
        };
        const el = pickTarget();
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const x = rect.left + Math.min(rect.width * 0.2, 30);
        const y = rect.top + rect.height / 2;
        const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
        for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mousemove', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, eventInit));
        }
        if (typeof PointerEvent !== 'undefined') {
            el.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, pointerId: 1, pointerType: 'mouse' }));
            el.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, pointerId: 1, pointerType: 'mouse' }));
        }
        if (el.click) {
            try { el.click(); } catch (_) { /* ignore */ }
        }
        return true;
    }).catch(() => false);
}

async function clickTurnstileIframeByBBox(page) {
    const iframes = await collectCaptchaIframeLocators(page);
    for (const iframe of iframes) {
        const box = await iframe.boundingBox({ timeout: 2000 }).catch(() => null);
        if (!box || box.width < 24 || box.height < 20) {
            continue;
        }
        const clickPoints = [
            [box.x + Math.min(30, box.width * 0.14), box.y + box.height / 2],
            [box.x + box.width * 0.22, box.y + box.height / 2],
            [box.x + box.width / 2, box.y + box.height / 2]
        ];
        for (const [x, y] of clickPoints) {
            captchaLog('click', `Turnstile iframe 物理坐标点击 (${Math.round(x)}, ${Math.round(y)})`);
            await humanClickAt(page, x, y);
            await humanPause(page, 1800, 3000);
            return true;
        }
    }
    return false;
}

async function humanClickInsideFrame(page, frame) {
    const innerTargets = [
        '#checkbox', '#anchor', '[id="checkbox"]', 'input[type="checkbox"]',
        'label.ctp-checkbox-label', '[role="checkbox"]', '.checkbox', 'label',
        '#challenge-stage', '.mark'
    ];
    for (const target of innerTargets) {
        try {
            const el = frame.locator(target).first();
            if (!(await el.isVisible({ timeout: 800 }))) continue;
            const box = await el.boundingBox({ timeout: 1000 });
            if (box) {
                await humanClickBoundingBox(page, box, target.includes('checkbox') ? 'checkbox-left' : 'center');
                captchaLog('click', `iframe 内点击 ${target}`);
                return true;
            }
            await el.click({ timeout: 2000, delay: randomBetween(40, 120) });
            captchaLog('click', `iframe 内 direct 点击 ${target}`);
            return true;
        } catch (_) { /* next */ }
    }
    return dispatchSyntheticClickInFrame(frame);
}

async function clickMainPageCloudflareCheckbox(page) {
    const patterns = [/verify you are human/i, /i am human/i, /select the checkbox/i];
    for (const re of patterns) {
        try {
            const label = page.getByText(re).first();
            if (!(await label.isVisible({ timeout: 800 }).catch(() => false))) continue;

            const container = label.locator('xpath=ancestor::div[contains(@class,"cb") or contains(@class,"challenge") or contains(@class,"cf-")][1]');
            const checkbox = container.locator('input[type="checkbox"], [role="checkbox"]').first();
            if (await checkbox.isVisible({ timeout: 600 }).catch(() => false)) {
                if (await humanClickLocator(page, checkbox, 'checkbox-left')) {
                    captchaLog('click', `主页面 Cloudflare 勾选框 (${re})`);
                    return true;
                }
            }

            const labelBox = await label.boundingBox({ timeout: 1000 }).catch(() => null);
            if (labelBox && await humanClickBoundingBox(page, {
                x: labelBox.x - 28,
                y: labelBox.y,
                width: Math.max(labelBox.width + 36, 40),
                height: labelBox.height
            }, 'checkbox-left')) {
                captchaLog('click', `主页面 Cloudflare 标签左侧 (${re})`);
                return true;
            }

            await label.click({ timeout: 2000, delay: randomBetween(50, 120) }).catch(() => {});
            captchaLog('click', `主页面 Cloudflare 标签点击 (${re})`);
            return true;
        } catch (_) { /* next */ }
    }
    return false;
}

async function waitForTurnstileReady(page, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const locators = await collectCaptchaIframeLocators(page);
        if (locators.length > 0 || await isHumanVerificationVisible(page)) {
            return locators;
        }
        await page.waitForTimeout(350);
    }
    return collectCaptchaIframeLocators(page);
}

async function attemptBypassHumanVerification(page, options = {}) {
    const { phase = 'poll' } = options;
    captchaLog(phase, '尝试模拟人类点击绕过验证...');

    const strategies = [
        'checkout-hcaptcha-modal',
        'turnstile-bbox',
        'hcaptcha-checkbox-frame',
        'main-page-cloudflare',
        'iframe-checkbox-left',
        'iframe-center',
        'frame-inner-elements',
        'modal-below-text',
        'dispatch-events',
        'all-iframes-scan'
    ];

    await waitForTurnstileReady(page, phase === 'post_submit' ? 12000 : 8000);
    await humanPause(page, 300, 700);

    const iframeLocators = await collectCaptchaIframeLocators(page);

    for (const strategy of strategies) {
        try {
            if (strategy === 'checkout-hcaptcha-modal') {
                if (!(await isCheckoutOverlayCaptchaVisible(page))) {
                    continue;
                }
                captchaLog(phase, '检测到 Checkout hCaptcha 弹层，优先点击 checkbox...');
                if (await clickHcaptchaCheckboxFrames(page, phase)) {
                    await humanPause(page, 2200, 3800);
                    return { attempted: true, strategy };
                }
                const modalIframe = page.locator(
                    'div:has-text("One more step") iframe, div:has-text("I am human") iframe'
                ).first();
                if (await humanClickLocator(page, modalIframe, 'checkbox-left')) {
                    captchaLog(phase, '策略 checkout-hcaptcha-modal 已点击弹层 iframe');
                    await humanPause(page, 2200, 3800);
                    return { attempted: true, strategy };
                }
                const modal = page.getByText(/one more step|select the checkbox/i).first();
                const modalBox = await modal.locator('xpath=ancestor::*[contains(@class,"Modal") or @role="dialog"][1]')
                    .boundingBox({ timeout: 1500 })
                    .catch(() => null);
                if (modalBox && await humanClickBoundingBox(page, modalBox, 'modal-below-text')) {
                    captchaLog(phase, '策略 checkout-hcaptcha-modal 已点击弹层下方');
                    await humanPause(page, 2200, 3800);
                    return { attempted: true, strategy };
                }
                continue;
            }

            if (strategy === 'turnstile-bbox') {
                if (await clickTurnstileIframeByBBox(page)) {
                    captchaLog(phase, '策略 turnstile-bbox 已执行');
                    return { attempted: true, strategy };
                }
                continue;
            }

            if (strategy === 'hcaptcha-checkbox-frame') {
                if (await clickHcaptchaCheckboxFrames(page, phase)) {
                    await humanPause(page, 1800, 3200);
                    return { attempted: true, strategy };
                }
                continue;
            }

            if (strategy === 'main-page-cloudflare') {
                if (await clickMainPageCloudflareCheckbox(page)) {
                    await humanPause(page, 1500, 2800);
                    return { attempted: true, strategy };
                }
                continue;
            }

            if (strategy === 'iframe-checkbox-left' || strategy === 'iframe-center') {
                const profile = strategy === 'iframe-checkbox-left' ? 'checkbox-left' : 'center';
                for (const iframe of iframeLocators) {
                    if (await humanClickLocator(page, iframe, profile)) {
                        captchaLog(phase, `策略 ${strategy} 已执行`);
                        await humanPause(page, 1200, 2200);
                        return { attempted: true, strategy };
                    }
                }
                continue;
            }

            if (strategy === 'frame-inner-elements') {
                for (const frame of page.frames()) {
                    if (!isBlockingCaptchaFrameUrl(frame.url())) continue;
                    if (await humanClickInsideFrame(page, frame)) {
                        captchaLog(phase, `策略 ${strategy} (${frame.url().slice(0, 60)}...)`);
                        await humanPause(page, 1200, 2200);
                        return { attempted: true, strategy };
                    }
                }
                for (const iframe of iframeLocators) {
                    const frame = iframe.contentFrame();
                    if (!frame) continue;
                    if (await humanClickInsideFrame(page, frame)) {
                        captchaLog(phase, `策略 ${strategy} (locator frame)`);
                        await humanPause(page, 1200, 2200);
                        return { attempted: true, strategy };
                    }
                }
                continue;
            }

            if (strategy === 'modal-below-text') {
                const modal = page.getByText(/one more step|select the checkbox|i am human|verify you are human/i).first();
                if (await modal.isVisible({ timeout: 800 }).catch(() => false)) {
                    const modalBox = await modal.locator('xpath=ancestor::*[contains(@class,"Modal") or contains(@role,"dialog")][1]').boundingBox({ timeout: 1500 }).catch(() => null)
                        || await modal.locator('xpath=ancestor::div[1]').boundingBox({ timeout: 1500 }).catch(() => null);
                    if (modalBox && await humanClickBoundingBox(page, modalBox, 'modal-below-text')) {
                        captchaLog(phase, `策略 ${strategy} 已执行`);
                        await humanPause(page, 1200, 2200);
                        return { attempted: true, strategy };
                    }
                }
                continue;
            }

            if (strategy === 'dispatch-events') {
                for (const frame of page.frames()) {
                    if (!isBlockingCaptchaFrameUrl(frame.url())) continue;
                    if (await dispatchSyntheticClickInFrame(frame)) {
                        captchaLog(phase, `策略 ${strategy} 已执行`);
                        await humanPause(page, 1500, 2500);
                        return { attempted: true, strategy };
                    }
                }
                continue;
            }

            if (strategy === 'all-iframes-scan') {
                const allIframes = page.locator('iframe');
                const count = await allIframes.count().catch(() => 0);
                for (let i = 0; i < count; i++) {
                    const iframe = allIframes.nth(i);
                    if (!(await iframe.isVisible({ timeout: 400 }).catch(() => false))) continue;
                    for (const profile of ['checkbox-left', 'center']) {
                        if (await humanClickLocator(page, iframe, profile)) {
                            captchaLog(phase, `策略 ${strategy} iframe #${i} ${profile}`);
                            await humanPause(page, 1200, 2200);
                            return { attempted: true, strategy: `${strategy}-${i}` };
                        }
                    }
                }
            }
        } catch (err) {
            captchaLog(phase, `策略 ${strategy} 失败: ${err.message}`, 'warn');
        }
    }

    captchaLog(phase, '所有模拟点击策略均未命中', 'warn');
    return { attempted: false };
}

async function attemptCaptchaPlatformSolver(page, phase = 'platform', verifyOpts = {}) {
    if (!isCaptchaPlatformEnabled()) {
        captchaLog(phase, '打码平台未配置，跳过', 'warn');
        return false;
    }

    const imageChallenge = await hasHcaptchaImageChallenge(page);
    if (imageChallenge) {
        captchaLog(phase, '已出现 hCaptcha 图片题，打码 token 注入无效，跳过平台解题', 'warn');
        return false;
    }

    captchaLog(phase, '尝试打码平台（createTask/getTaskResult）解题…');
    const params = await extractHcaptchaParamsFromPage(page);
    const userAgent = String(
        await page.evaluate(() => navigator.userAgent).catch(() => '')
        || process.env.HCAPTCHA_USER_AGENT
        || ''
    ).trim();
    captchaLog(
        phase,
        `提取参数 siteKey=${params.siteKey.slice(0, 12)}… rqdata=${params.rqdata ? 'yes' : 'no'} urls=${params.websiteUrls.length} ua=${userAgent ? 'yes' : 'no'}`
    );

    const solveResult = await solveHcaptchaViaPlatform({
        siteKey: params.siteKey,
        rqdata: params.rqdata,
        websiteUrls: params.websiteUrls,
        isInvisible: true,
        userAgent
    }, null, { budget: verifyOpts.budget });

    if (!solveResult.ok) {
        captchaLog(phase, `验证服务停止：${solveResult.code || 'VERIFICATION_PROVIDER_UNAVAILABLE'}`, 'error');
        throw Object.assign(new Error('验证服务未能完成'), {
            code: controlledVerificationCode(solveResult.code, 'VERIFICATION_PROVIDER_UNAVAILABLE')
        });
    }

    captchaLog(phase, `打码平台返回 token（${solveResult.token.length} chars），注入页面…`);
    await injectHcaptchaTokenOnPage(page, solveResult.token, solveResult.ekey);
    const budget = verifyOpts.budget || createVerificationBudget({ maxWaitMs: 35000 });
    const ownedBudget = !verifyOpts.budget;
    try {
    await budget.wait(500);
    while (budget.remaining() > 0) {
        const pageUrl = page.url() || '';
        if (/redirect_status=succeeded|checkout\/verify/i.test(pageUrl)) {
            captchaLog(phase, '打码平台 token 注入后支付已跳转成功页');
            return true;
        }
        if (await isVerificationCleared(page, verifyOpts)) {
            captchaLog(phase, '打码平台 token 注入后验证已通过');
            return true;
        }
        await budget.wait(500);
    }
    return false;
    } finally { if (ownedBudget) budget.dispose(); }
}

async function attemptHcaptchaVisualSolver(page, phase = 'visual', options = {}) {
    const ownedBudget = !options.budget;
    const budget = options.budget || createVerificationBudget(options);
    try {
        if (!isHcaptchaSolverEnabled()) return { ok: false, code: 'VERIFICATION_SOLVER_DISABLED', retryable: false };
        const state = await budget.run(prepareVerificationPage(page, { signal: options.signal }));
        const candidates = (await budget.run(inspectCaptchaFrames(page))).filter((item) => item.raster
            && item.prompts.some((prompt) => !isCheckboxInstruction(prompt)));
        if (candidates.length !== 1) return { ok: false,
            code: candidates.length ? 'VERIFICATION_FRAME_AMBIGUOUS' : 'VERIFICATION_NOT_READY', retryable: !candidates.length };
        budget.assert();
        const result = await solveHcaptchaOnPage({
            pageBinding: state.bindingId, timeoutMs: budget.remaining(), signal: budget.signal,
            challenge: state.challenge || null,
            locale: process.env.HCAPTCHA_BROWSER_LOCALE,
            timezoneId: process.env.HCAPTCHA_BROWSER_TIMEZONE,
            acceptLanguage: process.env.HCAPTCHA_ACCEPT_LANGUAGE
        });
        captchaLog(phase, result.ok ? '验证处理结束，正在检查原页面状态' : `验证处理停止：${result.code || 'VERIFICATION_SOLVER_FAILED'}`,
            result.ok ? 'info' : 'warn');
        return result;
    } finally { if (ownedBudget) budget.dispose(); }
}

function buildCaptchaRequiredError() {
    return '自动验证未能在本次期限内完成；保留原任务核对结果，禁止重复提交付款';
}

/**
 * 统一清除人机验证（登录、Checkout、支付各阶段调用）
 */
async function clearHumanVerification(page, options = {}) {
    let state = verificationState(page) || { revision: 0 };
    const budget = createVerificationBudget({ ...options, signal: options.signal || state.signal });
    const phase = options.phase || 'page';
    const requireCheckoutReady = options.requireCheckoutReady ?? /checkout/i.test(page.url() || '');
    const checkCheckoutLoad = requireCheckoutReady || options.checkCheckoutLoad === true;
    const checkoutDeadline = Date.now() + Math.min(budget.remaining(),
        Math.max(1, Number(options.checkoutReadyWaitMs) || 60000));
    const form = checkCheckoutLoad ? require('../checkout-form.cjs') : null;
    const recovery = checkCheckoutLoad && options.allowCheckoutReload === true
        ? require('../checkout-recovery.cjs') : null;
    const reloadOptions = { deadlineAt: budget.deadlineAt, signal: budget.signal,
        ownerSignal: recovery ? options.signal || state.signal || require('../rpc.cjs').taskSignal() : undefined,
        isSubmitted: options.isSubmitted || (() => require('../rpc.cjs').wasSubmitted()) };
    const maxRounds = Math.max(1, Math.min(4, Number(options.maxBypassRounds) || 4));
    const attempted = new Set();
    const clicked = new WeakSet();
    let rounds = 0, lastCode = 'VERIFICATION_NOT_READY', platformUsed = false, solverDiagnostics = {}, completedKey = null;
    let checkoutWaiting = false, readiness = null;
    const unknown = (code, retryable = false) => ({ cleared: false, captchaRequired: true,
        code, retryable, rounds, diagnostics: { state: lastCode, revision: state.revision, ...solverDiagnostics } });
    const checkoutFailure = (code) => ({ cleared: false, captchaRequired: false,
        checkoutNotReady: true, code, rounds,
        missing: readiness?.missing || ['number'], controls: readiness?.controls || [],
        ...(readiness?.inspection ? { inspection: readiness.inspection } : {}),
        diagnostics: { state: code,
            ...(readiness?.inspection ? { inspection: readiness.inspection } : {}),
            ...(recovery ? recovery.originalCheckoutReloadDiagnostics(page) : {}) } });
    const pendingCheckoutCode = () => !readiness || readiness.code === 'CHECKOUT_CARD_NOT_READY'
        ? 'CHECKOUT_FORM_NOT_READY' : readiness.code;
    try {
        state = await budget.run(prepareVerificationPage(page, { signal: options.signal || budget.signal }));
        while (budget.remaining() > 0) {
            budget.assert();
            if (page.isClosed?.()) return checkCheckoutLoad
                ? checkoutFailure('CHECKOUT_PAGE_CLOSED') : unknown('VERIFICATION_PAGE_CLOSED');
            if (await budget.run(isCheckoutLoginGate(page)) || await budget.run(hasVisibleLoginChrome(page)))
                return { ...unknown('SESSION_INVALID'), sessionRequired: true, message: buildSessionNotLoggedInError('验证页面') };
            if (checkCheckoutLoad && await budget.run(form.checkoutPageLoadFailed(page))) {
                checkoutWaiting = true;
                if (!recovery) return checkoutFailure('CHECKOUT_CONTENT_LOAD_FAILED');
                await budget.run(recovery.reloadOriginalCheckout(page, reloadOptions));
                continue;
            }
            const frames = await budget.run(inspectCaptchaFrames(page));
            const images = frames.filter((item) => item.raster
                && item.prompts.some((prompt) => !isCheckboxInstruction(prompt)));
            const boxes = frames.filter((item) => ['checkbox', 'turnstile'].includes(item.kind)
                && item.checkboxCount === 1 && !item.checked);
            if (images.length || boxes.length) checkoutWaiting = false;
            if (images.length > 1 || boxes.length > 1) return unknown('VERIFICATION_FRAME_AMBIGUOUS');
            if (!frames.some((item) => item.raster || !item.checked)
                && await budget.run(isVerificationCleared(page, { requireCheckoutReady: false }))) {
                if (!requireCheckoutReady)
                    return { cleared: true, rounds, via: state.passed ? 'verified-response' : 'page-readback' };
                checkoutWaiting = true;
                if (readiness && Date.now() >= checkoutDeadline)
                    return checkoutFailure(pendingCheckoutCode());
                readiness = await budget.run(form.inspectCardReadiness(page, {
                    deadline: Math.min(checkoutDeadline, Date.now() + 2000), signal: budget.signal
                }));
                if (readiness.ready && !await budget.run(form.checkoutPageLoadFailed(page))) {
                    const reload = recovery?.originalCheckoutReloadDiagnostics(page);
                    if (reload?.reloadAttempts && reload.code !== 'CHECKOUT_RELOAD_READY')
                        await budget.run(recovery.finishOriginalCheckoutReload(page, reloadOptions));
                    return { cleared: true, rounds, via: state.passed ? 'verified-response' : 'page-readback' };
                }
                if (Date.now() >= checkoutDeadline) return checkoutFailure(pendingCheckoutCode());
            }
            if (state.error && !['VERIFICATION_CHALLENGE_REJECTED'].includes(state.error))
                return unknown(state.error, ['VERIFICATION_NETWORK_UNAVAILABLE', 'VERIFICATION_PROVIDER_UNAVAILABLE', 'VERIFICATION_RATE_LIMITED'].includes(state.error));
            if (images.length === 1) {
                lastCode = 'VERIFICATION_CHALLENGE_READY';
                const frame = images[0];
                const key = `${state.challenge?.key || state.revision}:${frame.prompts.join('|')}`;
                if (attempted.has(key)) {
                    // A successful response may precede the frame/navigation update. Observe only;
                    // never re-open the solver or re-submit the same challenge while it settles.
                    if (completedKey === key) { await budget.wait(250); continue; }
                    return unknown('VERIFICATION_CHALLENGE_UNCHANGED');
                }
                if (rounds >= maxRounds) return unknown('VERIFICATION_ROUNDS_EXHAUSTED');
                attempted.add(key); rounds++;
                const result = await attemptHcaptchaVisualSolver(page, phase, { budget, signal: state.signal });
                budget.assert();
                const solverCode = controlledVerificationCode(result.code, 'VERIFICATION_SOLVER_FAILED');
                solverDiagnostics = { solverCode: result.ok ? null : solverCode, ...safeVerificationDiagnostics(result.diagnostics) };
                if (!result.ok && result.retryable !== true) return unknown(solverCode);
                if (result.ok) completedKey = key;
                // A solver response is never payment evidence. Re-observe this same page.
                await budget.wait(500);
                continue;
            }
            if (boxes.length === 1 && !clicked.has(boxes[0].frame)) {
                lastCode = 'VERIFICATION_CHECKBOX_READY';
                clicked.add(boxes[0].frame);
                await budget.run(clickHcaptchaCheckboxFrames(page, phase, budget));
                await budget.wait(700);
                continue;
            }
            lastCode = frames.length ? 'VERIFICATION_LOADING' : 'VERIFICATION_NOT_READY';
            if (boxes.length === 1 && !platformUsed && isCaptchaPlatformEnabled()) {
                platformUsed = true;
                const passed = await budget.run(attemptCaptchaPlatformSolver(page, phase, { requireCheckoutReady, budget }));
                if (passed) continue;
            }
            await budget.wait(500);
        }
        return checkoutWaiting ? checkoutFailure(pendingCheckoutCode()) : unknown('VERIFICATION_TIMEOUT', true);
    } catch (error) {
        if (error?.code === 'LEASE_LOST') throw error;
        if (/^CHECKOUT_[A-Z0-9_]+$/.test(error?.code || '')) return checkoutFailure(error.code);
        if (checkoutWaiting && error?.code === 'VERIFICATION_TIMEOUT')
            return checkoutFailure(pendingCheckoutCode());
        if (checkCheckoutLoad && page.isClosed?.()) return checkoutFailure('CHECKOUT_PAGE_CLOSED');
        if (checkoutWaiting && error?.code === 'VERIFICATION_CANCELLED')
            return checkoutFailure('CHECKOUT_FORM_ABORTED');
        return unknown(page.isClosed?.() ? 'VERIFICATION_PAGE_CLOSED' : controlledVerificationCode(error?.code),
            error?.code === 'VERIFICATION_TIMEOUT');
    } finally { budget.dispose(); }
}

module.exports = {
    prepareVerificationPage,
    disposeVerificationPage,
    isCheckoutOverlayCaptchaVisible,
    hasCheckoutCaptchaOverlayText,
    hasAnyCheckoutCaptchaSignal,
    hasVisiblePostSubmitHcaptchaWidget,
    waitForCheckoutOverlayCaptcha,
    isBlockingHumanVerificationVisible,
    isHumanVerificationVisible,
    isInvisibleStripeHcaptchaUrl,
    waitForCheckoutPaymentReady,
    isCloudflareWallPage,
    isCheckoutPaymentReady,
    isVerificationCleared,
    isPageBlocked,
    attemptBypassHumanVerification,
    attemptHcaptchaVisualSolver,
    attemptCaptchaPlatformSolver,
    clearHumanVerification,
    buildCaptchaRequiredError,
    isCaptchaFrameUrl,
    collectCaptchaIframeLocators,
    hasHcaptchaSolverTarget,
    hasHcaptchaImageChallenge,
    waitForPassiveCheckboxClear,
    clickHcaptchaCheckboxFrames,
};
