/**
 * hCaptcha 视觉求解器桥接模块
 *
 * 调用 hcaptcha/solver.py，通过 CDP 附加到
 * 当前 Playwright 浏览器页面，自动完成 Stripe Checkout 上的 hCaptcha challenge。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomInt } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { createVerificationBudget, controlledVerificationCode, safeVerificationDiagnostics } = require('./verification-runtime');

const DEFAULT_SOLVER_SCRIPT = path.join(__dirname, 'hcaptcha', 'solver.py');
const DEFAULT_OUT_DIR = path.join(__dirname, '..', 'runtime', 'solver');

function resolveSolverPython() {
    const candidates = [
        process.env.HCAPTCHA_SOLVER_PYTHON,
        process.env.PYTHON,
        process.env.CTFML_PYTHON,
        'python3',
        'python'
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (candidate.includes(path.sep) || candidate.startsWith('~')) {
            const expanded = candidate.replace(/^~/, os.homedir());
            if (fs.existsSync(expanded)) {
                return expanded;
            }
            continue;
        }
        return candidate;
    }
    return 'python3';
}

function isHcaptchaSolverEnabled() {
    if (process.env.HCAPTCHA_SOLVER_ENABLED === '0') {
        return false;
    }
    const scriptPath = process.env.HCAPTCHA_SOLVER_SCRIPT || DEFAULT_SOLVER_SCRIPT;
    if (!fs.existsSync(scriptPath)) {
        return false;
    }
    return true;
}

function getCdpUrl() {
    return String(process.env.CDP_URL || '').trim();
}

function buildSolverEnv() {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) if (/^(PATH|LANG|PYTHON|CTF_|HCAPTCHA_|CDP_|HEADFUL|HF_|TRANSFORMERS_)/.test(key)) env[key] = value;
    if (process.env.CTF_VLM_API_KEY) {
        env.CTF_VLM_API_KEY = process.env.CTF_VLM_API_KEY;
    }
    if (process.env.CTF_VLM_BASE_URL) {
        env.CTF_VLM_BASE_URL = process.env.CTF_VLM_BASE_URL;
    }
    if (process.env.CTF_VLM_MODEL) {
        env.CTF_VLM_MODEL = process.env.CTF_VLM_MODEL;
    }
    return env;
}

function extractJsonFromOutput(text) {
    const cleaned = String(text || '')
        .replace(/^\[hCaptcha\](?:\[stderr\])?\s*/gm, '')
        .trim();
    if (!cleaned) return null;

    try {
        const parsed = JSON.parse(cleaned);
        if (parsed && typeof parsed === 'object') {
            return parsed;
        }
    } catch (_) { /* try block extract */ }

    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            return JSON.parse(cleaned.slice(start, end + 1));
        } catch (_) { /* ignore */ }
    }

    const lines = cleaned.split('\n').reverse();
    for (const line of lines) {
        const candidate = line.trim();
        if (!candidate.startsWith('{')) continue;
        try {
            return JSON.parse(candidate);
        } catch (_) { /* try previous line */ }
    }
    return null;
}

function isSolverSuccessResult(parsed) {
    if (!parsed || typeof parsed !== 'object') {
        return false;
    }
    if (parsed.type === 'response' && String(parsed.response || '').trim()) {
        return true;
    }
    if (parsed.type === 'passive_checkbox') {
        const token = String(parsed.response || '').trim();
        const verified = Boolean(parsed.raw?.verified);
        return Boolean(token) || verified;
    }
    return Boolean(parsed.response);
}

/**
 * 通过 CDP 在当前 checkout 页面上运行 Python hCaptcha solver
 * @param {object} options
 * @param {string} [options.cdpUrl]
 * @param {string} options.pageBinding Exact task page identity installed before checkout.
 * @param {number} [options.timeoutSec]
 * @param {string} [options.locale]
 * @param {string} [options.timezoneId]
 * @param {string} [options.acceptLanguage]
 * @returns {Promise<{ ok: boolean, result?: object, error?: string, logPath?: string }>}
 */
function solveHcaptchaOnPage(options = {}) {
    const cdpUrl = String(options.cdpUrl || getCdpUrl() || '').trim();
    if (!cdpUrl) return Promise.resolve({ ok: false, code: 'VERIFICATION_SOLVER_DISABLED', retryable: false });
    if (!/^[0-9a-f-]{36}$/i.test(String(options.pageBinding || '')))
        return Promise.resolve({ ok: false, code: 'VERIFICATION_PAGE_BINDING_REQUIRED', retryable: false });
    const scriptPath = process.env.HCAPTCHA_SOLVER_SCRIPT || DEFAULT_SOLVER_SCRIPT;
    if (!fs.existsSync(scriptPath)) return Promise.resolve({ ok: false, code: 'VERIFICATION_SOLVER_DISABLED', retryable: false });
    const budget = createVerificationBudget({ signal: options.signal,
        maxWaitMs: Math.min(Number(options.timeoutMs) || Number(options.timeoutSec || process.env.HCAPTCHA_SOLVER_TIMEOUT || 180) * 1000, 180000) });
    try { budget.assert(); } catch (error) { budget.dispose(); return Promise.resolve({ ok: false, code: error.code, retryable: true }); }
    const outDir = process.env.HCAPTCHA_SOLVER_OUT_DIR || DEFAULT_OUT_DIR;
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const args = ['-u', scriptPath, '--timeout', String(budget.remaining() / 1000),
        '--out-dir', outDir, '--cdp-url', cdpUrl, '--attached-page-binding', options.pageBinding, '--initial-state-stdin'];
    const locale = String(options.locale || process.env.HCAPTCHA_BROWSER_LOCALE || 'en-US');
    args.push('--browser-locale', locale, '--browser-timezone',
        String(options.timezoneId || process.env.HCAPTCHA_BROWSER_TIMEZONE || 'America/Chicago'),
        '--accept-language', String(options.acceptLanguage || process.env.HCAPTCHA_ACCEPT_LANGUAGE || `${locale},en;q=0.9`));
    if (process.env.HCAPTCHA_SOLVER_NO_VLM === '1') args.push('--no-vlm');
    if (process.env.HEADFUL === '1') args.push('--headed');
    return new Promise((resolve) => {
        let proc, stdout = '', settled = false, terminationCode = null, forceTimer;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(forceTimer);
            budget.signal.removeEventListener('abort', abort);
            budget.dispose();
            resolve(value);
        };
        const abort = () => {
            if (forceTimer || settled) return;
            terminationCode ||= budget.signal.reason?.code || 'VERIFICATION_CANCELLED';
            if (!proc) return finish({ ok: false, code: terminationCode, retryable: true });
            try { proc.kill('SIGTERM'); } catch (_) { /* Already exited. */ }
            forceTimer = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch (_) { /* Already exited. */ }
            }, 1000);
            forceTimer.unref?.();
        };
        budget.signal.addEventListener('abort', abort, { once: true });
        try {
            proc = spawn(resolveSolverPython(), args, { env: buildSolverEnv(), cwd: path.dirname(scriptPath), stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (_) { return finish({ ok: false, code: 'VERIFICATION_SOLVER_FAILED', retryable: false }); }
        proc.stdin?.on('error', () => {});
        proc.stdin?.end(JSON.stringify({ challenge: options.challenge || null }));
        proc.stdout.on('data', (chunk) => {
            if (stdout.length + chunk.length > 1024 * 1024) {
                terminationCode = 'VERIFICATION_SOLVER_FAILED';
                abort();
                return;
            }
            stdout += chunk.toString();
        });
        // Never forward solver stdout/stderr: response tokens, screenshots and model payloads stay private.
        proc.stderr.on('data', () => {});
        proc.on('error', () => finish({ ok: false, code: 'VERIFICATION_SOLVER_FAILED', retryable: false }));
        proc.on('close', (code) => {
            if (terminationCode) return finish({ ok: false, code: terminationCode, retryable: terminationCode === 'VERIFICATION_TIMEOUT' });
            const parsed = extractJsonFromOutput(stdout);
            if (code === 0 && isSolverSuccessResult(parsed)) return finish({ ok: true, result: parsed });
            const resultCode = controlledVerificationCode(parsed?.code, 'VERIFICATION_SOLVER_FAILED');
            finish({ ok: false, code: resultCode, retryable: parsed?.retryable === true,
                diagnostics: safeVerificationDiagnostics(parsed) });
        });
        if (budget.signal.aborted) abort();
    });
}

function checkHcaptchaSolverHealth(options = {}) {
    const scriptPath = process.env.HCAPTCHA_SOLVER_SCRIPT || DEFAULT_SOLVER_SCRIPT;
    const pythonBin = resolveSolverPython();
    const enabled = process.env.HCAPTCHA_SOLVER_ENABLED !== '0';
    const hasVlmKey = Boolean(String(process.env.CTF_VLM_API_KEY || options.vlm_api_key || '').trim());
    const noVlm = process.env.HCAPTCHA_SOLVER_NO_VLM === '1' || Boolean(options.no_vlm);

    const status = {
        enabled,
        script_exists: fs.existsSync(scriptPath),
        script_path: scriptPath,
        python: pythonBin,
        cdp_url: getCdpUrl(),
        vlm_configured: hasVlmKey,
        no_vlm: noVlm,
        ready: false,
        message: ''
    };

    if (!enabled) {
        status.message = '后台已关闭 hCaptcha 自动求解';
        return Promise.resolve(status);
    }
    if (!status.script_exists) {
        status.message = `solver 脚本不存在: ${scriptPath}`;
        return Promise.resolve(status);
    }

    return new Promise((resolve) => {
        const proc = spawn(
            pythonBin,
            ['-c', 'import cv2, numpy, torch, transformers, playwright; print("ok")'],
            { env: buildSolverEnv() }
        );
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
        }, 45000);

        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        proc.on('error', (err) => {
            clearTimeout(timer);
            status.message = `Python 不可用 (${pythonBin}): ${err.message}`;
            resolve(status);
        });

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0 && stdout.includes('ok')) {
                status.ready = true;
                if (!noVlm && !hasVlmKey) {
                    status.message = '依赖就绪，但未配置 VLM API Key（将仅使用 CLIP/OpenCV 启发式）';
                } else {
                    status.message = 'hCaptcha solver 就绪';
                }
            } else {
                const hint = (stderr || stdout).split('\n').filter(Boolean).slice(-3).join(' | ');
                status.message = `Python 依赖检查失败: ${hint || `exit ${code}`}`;
            }
            resolve(status);
        });
    });
}

function normalizeVlmBaseUrl(baseUrl) {
    return String(baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
}

function buildVlmPayload(model, messages, maxTokens = 1024) {
    const payload = { model, messages };
    if (/^gpt-5(?:[.:-]|$)/i.test(model)) payload.max_completion_tokens = maxTokens;
    else Object.assign(payload, { temperature: 0, max_tokens: maxTokens });
    if (!/claude/i.test(model)) payload.response_format = { type: 'json_object' };
    return payload;
}

function adaptVlmParameter(payload, error) {
    if (error?.code !== 'unsupported_parameter') return false;
    const param = error.param;
    if (param === 'max_tokens' && 'max_tokens' in payload) {
        payload.max_completion_tokens = payload.max_tokens; delete payload.max_tokens;
    } else if (param === 'max_completion_tokens' && 'max_completion_tokens' in payload) {
        payload.max_tokens = payload.max_completion_tokens; delete payload.max_completion_tokens;
    } else if (['temperature', 'response_format'].includes(param) && param in payload) delete payload[param];
    else return false;
    return true;
}

function visionProbe() {
    const colours = [['red', [235, 32, 32]], ['blue', [31, 80, 230]], ['green', [20, 170, 50]]];
    const [colour, rgb] = colours[randomInt(colours.length)];
    const side = 48, raw = Buffer.alloc(side * (side * 3 + 1), 255);
    for (let y = 0; y < side; y++) {
        raw[y * (side * 3 + 1)] = 0;
        for (let x = 10; x < 38 && y >= 10 && y < 38; x++)
            rgb.forEach((value, c) => { raw[y * (side * 3 + 1) + 1 + x * 3 + c] = value; });
    }
    const crc = (bytes) => {
        let value = 0xffffffff;
        for (const byte of bytes) {
            value ^= byte;
            for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
        }
        return (value ^ 0xffffffff) >>> 0;
    };
    const chunk = (name, data) => {
        const kind = Buffer.from(name), length = Buffer.alloc(4), sum = Buffer.alloc(4);
        length.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([kind, data])));
        return Buffer.concat([length, kind, data, sum]);
    };
    const header = Buffer.alloc(13); header.writeUInt32BE(side, 0); header.writeUInt32BE(side, 4); header[8] = 8; header[9] = 2;
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    return { colour, image: `data:image/png;base64,${png.toString('base64')}` };
}

function vlmHttpCode(status, error) {
    if (['image_unsupported', 'unsupported_content_type', 'invalid_image_format'].includes(error?.code)) return 'VLM_IMAGE_UNSUPPORTED';
    return [401, 403].includes(status) ? 'VLM_AUTH_FAILED' : status === 429 ? 'VLM_RATE_LIMITED'
        : status >= 500 ? 'VLM_PROVIDER_UNAVAILABLE' : status === 400 ? 'VLM_REQUEST_UNSUPPORTED' : 'VLM_API_REJECTED';
}

/** A synthetic picture checks vision and JSON together; no checkout screenshot is used. */
async function testVlmConnectivity(cfg = {}) {
    const apiKey = String(cfg.vlm_api_key || process.env.CTF_VLM_API_KEY || '').trim();
    const baseUrl = normalizeVlmBaseUrl(cfg.vlm_base_url || process.env.CTF_VLM_BASE_URL);
    const model = String(cfg.vlm_model || process.env.CTF_VLM_MODEL || 'gpt-5.5').trim();
    if (!apiKey) return { ok: false, code: 'VLM_NOT_CONFIGURED', message: '未配置视觉服务凭据', image_json_verified: false };
    const started = Date.now(), probe = visionProbe();
    const payload = buildVlmPayload(model, [{ role: 'user', content: [
        { type: 'text', text: 'Inspect the image. Return ONLY a JSON object with keys colour (red, blue or green) and shape for the single coloured shape on the white background.' },
        { type: 'image_url', image_url: { url: probe.image, detail: 'high' } }
    ] }]);
    const budget = createVerificationBudget({ signal: cfg.signal, maxWaitMs: Number(cfg.vlm_timeout || process.env.CTF_VLM_TIMEOUT || 45) * 1000 });
    const failed = (code, status, providerCode) => ({ ok: false, code, message: '视觉图像与结构化结果检测未通过',
        model, latency_ms: Date.now() - started, image_json_verified: false,
        ...(status ? { http_status: status } : {}),
        ...(/^[a-zA-Z0-9_]{1,60}$/.test(providerCode || '') ? { provider_code: providerCode } : {}) });
    try {
        for (let attempt = 0; attempt < 2; attempt++) {
            budget.assert();
            const response = await budget.run(fetch(`${baseUrl}/chat/completions`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify(payload), signal: budget.signal
            }));
            let body;
            try { body = await budget.run(response.json()); }
            catch (_) { if (budget.signal.aborted) throw budget.signal.reason; return failed('VLM_INVALID_RESPONSE', response.status); }
            if (!response.ok) {
                const error = body?.error || {};
                if (attempt === 0 && response.status === 400 && adaptVlmParameter(payload, error)) continue;
                return failed(vlmHttpCode(response.status, error), response.status, error.code);
            }
            const content = body?.choices?.[0]?.message?.content;
            let parsed;
            try { parsed = JSON.parse(typeof content === 'string' ? content : ''); }
            catch (_) { return failed('VLM_INVALID_RESPONSE', response.status); }
            if (String(parsed.colour || '').toLowerCase() !== probe.colour || String(parsed.shape || '').toLowerCase() !== 'square')
                return failed('VLM_VISION_CHECK_FAILED', response.status);
            return { ok: true, code: 'VLM_VISION_JSON_VERIFIED', message: '视觉图像及结构化结果检测通过',
                model, latency_ms: Date.now() - started, http_status: response.status, image_json_verified: true };
        }
        return failed('VLM_REQUEST_UNSUPPORTED');
    } catch (error) {
        if (budget.signal.reason?.code === 'LEASE_LOST') throw budget.signal.reason;
        return failed(budget.signal.aborted ? 'VLM_TIMEOUT' : error?.name === 'AbortError' ? 'VLM_TIMEOUT' : 'VLM_NETWORK_UNAVAILABLE');
    } finally { budget.dispose(); }
}

function listSolverLogFiles(limit = 20) {
    const outDir = process.env.HCAPTCHA_SOLVER_OUT_DIR || DEFAULT_OUT_DIR;
    try {
        if (!fs.existsSync(outDir)) {
            return { out_dir: outDir, files: [] };
        }
        const files = fs.readdirSync(outDir)
            .filter((name) => /solver.*\.log$/i.test(name) || /^round_\d+\.json$/i.test(name))
            .map((name) => {
                const full = path.join(outDir, name);
                const stat = fs.statSync(full);
                return {
                    name,
                    path: full,
                    size: stat.size,
                    mtime: stat.mtimeMs
                };
            })
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, Math.max(1, limit));
        return { out_dir: outDir, files };
    } catch (error) {
        return { out_dir: outDir, files: [], error: error.message };
    }
}

function readSolverLogTail(filePath, maxLines = 80) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw.split('\n').filter((l) => l.trim());
        return lines.slice(-maxLines);
    } catch (error) {
        return [`读取失败: ${error.message}`];
    }
}

module.exports = {
    solveHcaptchaOnPage,
    isHcaptchaSolverEnabled,
    checkHcaptchaSolverHealth,
    testVlmConnectivity,
    listSolverLogFiles,
    readSolverLogTail,
    getCdpUrl,
    resolveSolverPython,
    DEFAULT_SOLVER_SCRIPT,
    buildVlmPayload,
    adaptVlmParameter
};
