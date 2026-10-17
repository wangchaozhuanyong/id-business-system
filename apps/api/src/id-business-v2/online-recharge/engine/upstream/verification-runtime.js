'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const pages = new WeakMap();
const RESULT_CODES = new Set([
    'SESSION_INVALID', 'LEASE_LOST', 'VERIFICATION_TIMEOUT', 'VERIFICATION_CANCELLED',
    'VERIFICATION_PAGE_CLOSED', 'VERIFICATION_FRAME_AMBIGUOUS', 'VERIFICATION_NOT_READY',
    'VERIFICATION_NETWORK_UNAVAILABLE', 'VERIFICATION_PROVIDER_UNAVAILABLE',
    'VERIFICATION_PROVIDER_REJECTED', 'VERIFICATION_RATE_LIMITED', 'VERIFICATION_CHALLENGE_REJECTED',
    'VERIFICATION_CHALLENGE_UNCHANGED', 'VERIFICATION_ROUNDS_EXHAUSTED', 'VERIFICATION_SOLVER_DISABLED',
    'VERIFICATION_SOLVER_FAILED', 'VERIFICATION_RUNTIME_FAILED', 'VERIFICATION_PAGE_BINDING_REQUIRED',
    'VERIFICATION_PAGE_BINDING_MISMATCH', 'VERIFICATION_UNSUPPORTED', 'VLM_AUTH_FAILED',
    'VLM_RATE_LIMITED', 'VLM_TIMEOUT', 'VLM_NETWORK_UNAVAILABLE', 'VLM_REQUEST_UNSUPPORTED',
    'VLM_INVALID_RESPONSE', 'VLM_INVALID_DECISION', 'VLM_PROVIDER_UNAVAILABLE',
    'VLM_IMAGE_UNSUPPORTED', 'VLM_NOT_CONFIGURED', 'VLM_API_REJECTED'
]);
const controlledVerificationCode = (value, fallback = 'VERIFICATION_RUNTIME_FAILED') => RESULT_CODES.has(value) ? value : fallback;
function safeVerificationDiagnostics(value) {
    return { ...(Number.isInteger(value?.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? { httpStatus: value.httpStatus } : {}),
        ...(typeof value?.providerCode === 'string' && /^[a-zA-Z0-9_]{1,60}$/.test(value.providerCode) ? { providerCode: value.providerCode } : {}) };
}
const CHECKBOX_TEXT = /select the checkbox(?: below)?|one more step before|\bi am human\b|verify (?:that )?you are human/i;
const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const isCheckboxInstruction = (value) => CHECKBOX_TEXT.test(normalize(value));
const isImagePrompt = (value) => !isCheckboxInstruction(value) && !/^please try again|^(?:skip|next|verify|en)[.!?]?$/i.test(normalize(value))
    && /click|select|drag|tap|choose|identify|match|different|complete|water travel|float on water|produce heat|served hot|hop|shiny|dissolve|conceal|hidden/i.test(normalize(value));

function verificationError(code) {
    const messages = {
        VERIFICATION_TIMEOUT: '自动验证超过本次总期限',
        VERIFICATION_CANCELLED: '自动验证已取消',
        LEASE_LOST: '任务租约已失效'
    };
    return Object.assign(new Error(messages[code] || '自动验证未能完成'), { code });
}

function taskSignal() {
    try { return require('../rpc.cjs').taskSignal?.(); } catch (_) { return undefined; }
}

function createVerificationBudget(options = {}) {
    const controller = new AbortController();
    const outer = options.signal || taskSignal();
    const duration = Math.max(1, Math.min(180000, Number(options.maxWaitMs) || 180000));
    const deadlineAt = Math.min(performance.now() + duration,
        Number.isFinite(options.deadlineAt) ? options.deadlineAt : Infinity);
    const cancel = () => controller.abort(verificationError(
        outer?.reason?.code === 'LEASE_LOST' ? 'LEASE_LOST' : 'VERIFICATION_CANCELLED'));
    if (outer?.aborted) cancel();
    else outer?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(verificationError('VERIFICATION_TIMEOUT')),
        Math.max(0, deadlineAt - performance.now()));
    timer.unref?.();
    const assert = () => {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (performance.now() >= deadlineAt) throw verificationError('VERIFICATION_TIMEOUT');
    };
    return {
        deadlineAt,
        signal: controller.signal,
        remaining() { return Math.max(0, deadlineAt - performance.now()); },
        timeout(max = 1000) { assert(); return Math.max(1, Math.floor(Math.min(max, deadlineAt - performance.now()))); },
        assert,
        async run(promise) {
            assert();
            return new Promise((resolve, reject) => {
                const abort = () => reject(controller.signal.reason);
                controller.signal.addEventListener('abort', abort, { once: true });
                Promise.resolve(promise).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
            });
        },
        async wait(ms) {
            assert();
            await new Promise((resolve, reject) => {
                const abort = () => { clearTimeout(wait); reject(controller.signal.reason); };
                const wait = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, Math.min(ms, deadlineAt - performance.now()));
                controller.signal.addEventListener('abort', abort, { once: true });
            });
            assert();
        },
        dispose() { clearTimeout(timer); outer?.removeEventListener('abort', cancel); }
    };
}

function captchaHost(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host === 'hcaptcha.com' || host.endsWith('.hcaptcha.com') || host === 'challenges.cloudflare.com';
    } catch (_) { return false; }
}

function frameKind(url) {
    let raw;
    try { raw = decodeURIComponent(String(url || '')).toLowerCase(); } catch (_) { return ''; }
    if (!captchaHost(raw)) return '';
    if (/frame=challenge(?:[&#]|$)/.test(raw)) return 'challenge';
    if (/frame=checkbox(?:[&#]|$)/.test(raw)) return 'checkbox';
    if (raw.includes('challenges.cloudflare.com')) return 'turnstile';
    return 'candidate';
}

async function frameVisible(frame) {
    try {
        if (!frame.parentFrame?.()) return false;
        const element = await frame.frameElement();
        try {
            if (!await element.isVisible()) return false;
            if (!await element.evaluate((node) => {
                for (let current = node; current; current = current.parentElement) {
                    const style = getComputedStyle(current);
                    if (current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true'
                        || style.display === 'none' || style.visibility === 'hidden'
                        || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
                }
                return true;
            })) return false;
            const box = await element.boundingBox();
            if (!box || box.width <= 4 || box.height <= 4) return false;
            const parent = frame.parentFrame();
            return parent.parentFrame?.() ? await frameVisible(parent) : true;
        } finally { await element.dispose?.(); }
    } catch (_) { return false; }
}

async function inspectCaptchaFrames(page) {
    const frames = [];
    for (const frame of page.frames()) {
        const kind = frameKind(frame.url());
        if (!kind || !await frameVisible(frame)) continue;
        try {
            const info = await frame.evaluate(() => {
                const visible = (el) => {
                    if (!el) return false;
                    const rect = el.getBoundingClientRect();
                    if (rect.width <= 4 || rect.height <= 4) return false;
                    for (let current = el; current; current = current.parentElement) {
                        const style = getComputedStyle(current);
                        if (current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true'
                            || style.display === 'none' || style.visibility === 'hidden'
                            || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
                    }
                    return true;
                };
                const rawBody = String(document.body?.innerText || '');
                const body = rawBody.replace(/\s+/g, ' ').trim();
                const prompts = [...document.querySelectorAll('#prompt-question, .prompt-text, [data-theme="challenge-container"] h2')]
                    .filter(visible).map((el) => String(el.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
                const raster = [...document.querySelectorAll('canvas, .task-grid img, .task-image, .challenge-image, [class*="task-image"]')].some(visible);
                const checkboxes = [...document.querySelectorAll('#checkbox, #anchor, [role="checkbox"], input[type="checkbox"]')].filter(visible);
                const checkbox = checkboxes.length === 1 ? checkboxes[0] : null;
                return { body: body.slice(0, 600), prompts: prompts.slice(0, 4), bodyLines: rawBody.split('\n').slice(0, 12), raster,
                    checkboxCount: checkboxes.length, checked: checkbox
                        ? checkbox.getAttribute('aria-checked') === 'true' || checkbox.checked === true : false };
            });
            info.prompts = [...new Set([...info.prompts, ...info.bodyLines].filter(isImagePrompt))].slice(0, 4);
            delete info.bodyLines;
            frames.push({ frame, kind, ...info });
        } catch (_) { /* A rebuilding frame is observed again on the next iteration. */ }
    }
    return frames;
}

function safePrompt(data) {
    const source = data?.requester_question;
    const raw = typeof source === 'string' ? source
        : source && typeof source === 'object' ? source.en || source['en-US'] || '' : '';
    const prompt = normalize(raw).slice(0, 500);
    return isCheckboxInstruction(prompt) ? '' : prompt;
}

async function prepareVerificationPage(page, options = {}) {
    const prior = pages.get(page);
    if (prior) { await prior.ready; return prior; }
    const controller = new AbortController();
    const outer = options.signal || taskSignal();
    const state = {
        bindingId: randomUUID(), signal: controller.signal, generation: 0,
        challenge: null, passed: false, error: null, revision: 0, latestRequest: 0
    };
    const requests = new WeakMap();
    const request = (req) => {
        if (!captchaHost(req.url())) return;
        if (/\/getcaptcha(?:\/|\?)/.test(req.url()))
            requests.set(req, { generation: state.generation, sequence: ++state.latestRequest, kind: 'get' });
        else if (/\/checkcaptcha\//.test(req.url()))
            requests.set(req, { generation: state.generation, challengeKey: state.challenge?.key, kind: 'check' });
    };
    const cancel = () => controller.abort(outer?.reason || verificationError('VERIFICATION_CANCELLED'));
    if (outer?.aborted) cancel(); else outer?.addEventListener('abort', cancel, { once: true });
    const reset = () => { state.generation++; state.challenge = null; state.passed = false; state.error = null; state.revision++; };
    const navigation = (frame) => { if (frame === page.mainFrame()) reset(); };
    const response = async (resp) => {
        const generation = state.generation;
        try {
            const url = resp.url();
            if (!captchaHost(url)) return;
            if (!/\/getcaptcha(?:\/|\?)|\/checkcaptcha\//.test(url)) return;
            const pending = requests.get(resp.request());
            const isCurrent = () => !pending || pending.generation === state.generation
                && (pending.kind === 'get' ? pending.sequence === state.latestRequest : pending.challengeKey === state.challenge?.key);
            if (!isCurrent()) return;
            const status = resp.status();
            if (status >= 400) {
                state.error = status === 429 ? 'VERIFICATION_RATE_LIMITED'
                    : status >= 500 ? 'VERIFICATION_PROVIDER_UNAVAILABLE' : 'VERIFICATION_PROVIDER_REJECTED';
                state.revision++;
                return;
            }
            const data = await resp.json();
            if (state.generation !== generation || !isCurrent() || !data || typeof data !== 'object') return;
            if (/\/getcaptcha(?:\/|\?)/.test(url)) {
                state.revision++;
                state.passed = false;
                state.error = null;
                const key = String(data.key || '') || `${state.revision}`;
                state.challenge = {
                    key: createHash('sha256').update(key).digest('hex').slice(0, 24),
                    prompt: safePrompt(data), requestType: String(data.request_type || data.mode || '').slice(0, 60),
                    taskCount: Array.isArray(data.tasklist) ? data.tasklist.length : 0, revision: state.revision
                };
            } else if (data.pass === true) { state.passed = true; state.error = null; state.revision++; }
            else if (data.pass === false) {
                state.challenge = null; state.passed = false; state.error = 'VERIFICATION_CHALLENGE_REJECTED'; state.revision++;
            }
        } catch (_) { /* Unreadable network events are not proof of invalid login or a solved challenge. */ }
    };
    const requestFailed = (request) => {
        const pending = requests.get(request);
        if (pending?.generation === state.generation && (pending.kind !== 'get' || pending.sequence === state.latestRequest)) {
            state.error = 'VERIFICATION_NETWORK_UNAVAILABLE'; state.revision++;
        }
    };
    const close = () => controller.abort(verificationError('VERIFICATION_CANCELLED'));
    state.dispose = () => {
        controller.abort(verificationError('VERIFICATION_CANCELLED'));
        outer?.removeEventListener('abort', cancel);
        page.off('response', response); page.off('requestfailed', requestFailed);
        page.off('request', request);
        page.off('framenavigated', navigation); page.off('close', close);
        pages.delete(page);
    };
    pages.set(page, state);
    page.on('response', response); page.on('requestfailed', requestFailed);
    page.on('request', request);
    page.on('framenavigated', navigation); page.on('close', close);
    state.ready = (async () => {
        const marker = (id) => Object.defineProperty(window, '__onlineRechargeVerificationBinding', {
            value: id, configurable: true, writable: false
        });
        await page.addInitScript(marker, state.bindingId);
        await page.evaluate(marker, state.bindingId);
    })();
    try { await state.ready; return state; } catch (error) { state.dispose(); throw error; }
}

function disposeVerificationPage(page) { pages.get(page)?.dispose(); }
function verificationState(page) { return pages.get(page); }

module.exports = {
    createVerificationBudget, verificationError, isCheckboxInstruction, isImagePrompt, captchaHost,
    frameKind, frameVisible, inspectCaptchaFrames, prepareVerificationPage,
    disposeVerificationPage, verificationState, controlledVerificationCode, safeVerificationDiagnostics
};
