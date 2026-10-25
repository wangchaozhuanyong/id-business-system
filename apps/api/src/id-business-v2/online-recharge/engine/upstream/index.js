const { executePaymentWithRetry } = require('./payment-retry');
const { openPricingCheckout } = require('./pricing-checkout');
const { openApiCheckout } = require('./chatgpt');
const store = require('./mysql-store');
const { getRegionConfig, getRegionBrowserProfile } = require('./region-config');
const { installChatGptSession, bootstrapChatGptSession } = require('./session-auth');
const { cancelAutoRenew } = require('./subscription-check');
const { connectTaskBrowser, applyCdpEnv, closeTaskBrowser } = require('./browser-runtime');
const { preparePlaywrightProxy } = require('./playwright-proxy');
const fs = require('fs');
const safeMedia = require('../safe-media.cjs');
const { wasSubmitted, taskSignal } = require('../rpc.cjs');
const path = require('path');

/**
 * Stripe Card Pool Payment Activation Flow
 *
 * 核心流程：
 * 1. 代理连通性检查（包含首次最多 5 次，成功即继续，连续失败 5 次才停止）
 * 2. 从 CDK 记录获取 plan_type
 * 3. 创建 Stripe Checkout Session（根据 plan_type）
 * 4. 打开 Stripe Checkout 页面
 * 5. 使用 payment-retry.js（executePaymentWithRetry）完成信用卡支付
 *    - 使用任务预检固定的单张银行卡
 *    - 保留原单与提交保护，付款提交后不换卡或再次提交
 *    - 自动选取免税地址
 *    - 记录账单信息
 * 6. 检测支付结果：成功则继续，失败则标记 payment_failed
 *
 * 进度输出约定（供 server.js / product_activator.js 解析）：
 * - "正在检查代理连通性"  → 代理检查开始
 * - "代理连接成功! 代理公网 IP" → 代理检查通过
 * - "[1] 创建订单" → 订单创建开始
 * - "套餐类型:" → plan_type/region 已解析
 * - "定价页" / "Checkout 页面已打开" → UI 升级流程
 * - "[Stripe] Step" → 填写信用卡与账单地址
 * - "正在使用 Stripe 信用卡卡池支付流程" → 支付流程开始
 * - "最终校验：支付成功!" / "PAYMENT_SUCCESS" → 成功
 * - "支付失败 (payment_failed)" → 全部卡片均失败
 * - "支付失败 (stripe_card_declined)" → 卡被拒
 */

// 全部敏感配置请通过环境变量传入
const CONFIG = {
    chatgptToken: process.env.CHATGPT_TOKEN || "",
    chatgptSessionJson: process.env.CHATGPT_SESSION_JSON || "",
    cdkCode: process.env.CDK_CODE || "",
    email: process.env.ACTIVATION_EMAIL || "",
    planType: process.env.CDK_PLAN_TYPE || "",
    planNameOverride: process.env.PLAN_NAME_OVERRIDE || "",
    paymentRegionOverride: process.env.PAYMENT_REGION_OVERRIDE || "",
    proxy: process.env.PROXY || ""
};

// 录像开关（默认开启；设 RECORD_VIDEO=0 可关闭）与输出目录
const RECORD_VIDEO = String(process.env.RECORD_VIDEO || '1') !== '0';
const VIDEO_DIR = path.join(__dirname, 'debug_screenshots', 'videos');
const VIDEO_TAG = (process.env.JOB_KEY || process.env.CDK_CODE || `${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || `${Date.now()}`;
const DEBUG_PAYMENT_BUTTON_PATTERNS = [/^Subscribe$/i, /^订阅$/, /^立即支付$/, /^Pay now$/i, /^Upgrade to Pro$/i];

const waitForDebugPaymentStep = async (page, timeout = 60000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        for (const pattern of DEBUG_PAYMENT_BUTTON_PATTERNS) {
            const button = page.getByRole('button', { name: pattern });
            const count = await button.count();
            if (count === 1 && await button.isVisible({ timeout: 500 })) {
                console.log(`✅ [调试] 已到达最终付款步骤，检测到提交按钮: ${pattern}`);
                return;
            }
        }
        await page.waitForTimeout(500);
    }
    throw new Error('调试未到达最终付款步骤：未检测到订阅/支付提交按钮');
};

function buildDebugScreenshotPath(prefix) {
    const subdir = process.env.CHECKOUT_DEBUG_ONLY === '1' ? 'checkout_debug' : 'activation';
    const screenshotDir = path.join(__dirname, 'debug_screenshots', subdir);
    fs.mkdirSync(screenshotDir, { recursive: true });
    return path.join(screenshotDir, `${prefix}_${Date.now()}.png`);
}

// 关闭 context 后把录像重命名为带任务标识的稳定文件名，并输出路径供 server 解析
async function finalizeVideo(options = {}) { return safeMedia.finish(options); }

function getAvailableDebugPage(context, preferredPage) {
    if (preferredPage && !preferredPage.isClosed()) {
        return preferredPage;
    }
    if (!context || typeof context.pages !== 'function') {
        return null;
    }
    const alivePages = context.pages().filter((item) => item && !item.isClosed());
    return alivePages.length ? alivePages[alivePages.length - 1] : null;
}

async function captureDebugScreenshot(context, preferredPage, prefix, label = '异常截图') {
    const targetPage = getAvailableDebugPage(context, preferredPage);
    if (!targetPage) {
        console.warn(`⚠️ [系统] ${label}未保存：当前没有可用页面。`);
        return null;
    }

    return safeMedia.screenshot(targetPage, prefix);
}

async function isCheckoutErrorPage(page) {
    try {
        const bodyText = String(await page.textContent('body', { timeout: 3000 }).catch(() => '') || '');
        return bodyText.includes('Something went wrong')
            || bodyText.includes('could not be found')
            || bodyText.includes('contact the merchant');
    } catch (_) {
        return false;
    }
}

async function isConnectionClosedPage(page) {
    try {
        const bodyText = String(await page.textContent('body', { timeout: 3000 }).catch(() => '') || '');
        return bodyText.includes('ERR_CONNECTION_CLOSED')
            || bodyText.includes('无法访问此网站')
            || bodyText.includes('意外终止了连接')
            || bodyText.includes('This site can\u2019t be reached')
            || bodyText.includes('This site cannot be reached');
    } catch (_) {
        return false;
    }
}

async function recoverConnectionClosed(page, fallbackUrl = '') {
    if (!(await isConnectionClosedPage(page))) {
        return false;
    }

    console.warn('[Warn] 检测到浏览器连接关闭错误页，正在尝试自动重载...');
    for (let attempt = 1; attempt <= 3; attempt++) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(async () => {
            const nextUrl = fallbackUrl || page.url();
            if (nextUrl) {
                return page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
            }
        });
        await page.waitForTimeout(3000);
        if (!(await isConnectionClosedPage(page))) {
            console.log(`[Info] 连接关闭错误页已恢复 (第 ${attempt} 次重载成功)。`);
            return true;
        }
    }

    return false;
}

/**
 * Main Automation logic
 */
async function run(runOptions = {}) {
    // 切到有头模式调试：HEADFUL=1 node server.js 或 HEADFUL=1 node index.js
    const DEBUG_HEADFUL = process.env.HEADFUL === '1';
    const CHROMIUM_CHANNEL = (process.env.CHROMIUM_CHANNEL || '').trim();
    const debugOnly = process.env.CHECKOUT_DEBUG_ONLY === '1';
    const validation = runOptions.unpaidValidation === true ? require('../unpaid-validation.cjs') : null;
    const nativeSession = Boolean(process.env.ONLINE_RECHARGE_PROFILE_ROOT);
    const verificationHandler = nativeSession ? async () => {
        throw Object.assign(new Error('官网要求进一步验证，已停止本次任务'), { code: 'CHALLENGE_BLOCKED', challengeDetected: true });
    } : validation ? validation.automaticVerification : require('../human-verification.cjs').waitForHumanVerification;

    let proxyCleanup = async () => { };
    let browserSession = null;
    let browser = null;
    let context = null;
    let page = null;
    let authDiagnostics = null;
    let paymentSucceeded = false;
    let lastPaymentResult = null;
    let checkoutEvidence = {};
    let challengeBlocked = false;

    validation?.stage('proxy');
    try {
        const preparedProxy = await preparePlaywrightProxy(CONFIG.proxy);
        proxyCleanup = preparedProxy.cleanup;
        const proxyConfig = preparedProxy.proxyConfig;

        if (proxyConfig) {
            console.log(`🌐 [系统] 代理已配置${preparedProxy.relayed ? '（SOCKS→本地 HTTP 中继）' : ''}`);
        }

        const paymentRegion = String(CONFIG.paymentRegionOverride || '').trim().toUpperCase()
            || await store.getPaymentRegion();
        const regionCfg = getRegionConfig(paymentRegion);
        const browserProfile = getRegionBrowserProfile(paymentRegion);

        const contextOptions = { viewport: { width: 1920, height: 1080 },
            locale: browserProfile.locale, timezoneId: browserProfile.timezoneId,
            ...(proxyConfig ? { proxy: proxyConfig } : {}) };
        browserSession = await connectTaskBrowser({ proxyConfig, headful: DEBUG_HEADFUL,
            chromiumChannel: CHROMIUM_CHANNEL, contextOptions, signal: taskSignal?.() });
        applyCdpEnv(browserSession);
        browser = browserSession.browser;

        // Actual pages are recorded only as mandatory masked screenshot frames.
        await safeMedia.start(browser);

        context = browserSession.context || await browser.newContext(contextOptions);
        const sessionRaw = CONFIG.chatgptSessionJson || CONFIG.chatgptToken;
        validation?.stage('login');
        const installResult = await installChatGptSession(context, sessionRaw, {
            signal: taskSignal?.(), onHumanVerification: verificationHandler,
            nativeSession, preserveStoredSession: nativeSession
        });
        const sessionData = installResult?.sessionData || installResult;
        const cookieVerified = Boolean(installResult?.cookieVerified);

        // --- Phase 0: Proxy Connectivity Check ---
        if (!browserSession.context) validation?.stage('proxy');
        if (proxyConfig && !browserSession.context) {
            // 模块业务规则：只重试原代理的连通性探测，不重启任务或重复建单、付款。
            const maxProxyAttempts = 5;
            for (let attempt = 1; attempt <= maxProxyAttempts; attempt++) {
                taskSignal?.()?.throwIfAborted();
                console.log(`正在检查代理连通性...（第 ${attempt}/${maxProxyAttempts} 次）`);
                try {
                    const probeResponse = await context.request.get("http://api.ipify.org/?format=text", {
                        timeout: 15000
                    });
                    taskSignal?.()?.throwIfAborted();
                    if (!probeResponse.ok()) {
                        throw new Error(`代理响应异常: HTTP ${probeResponse.status()}`);
                    }
                    const ip = (await probeResponse.text()).trim();
                    taskSignal?.()?.throwIfAborted();
                    console.log(`✅ [系统] 代理连接成功! 代理公网 IP: ${ip}（第 ${attempt}/${maxProxyAttempts} 次）`);
                    break;
                } catch (proxyError) {
                    if (proxyError.code === 'LEASE_LOST' || taskSignal?.()?.aborted) throw proxyError;
                    // 不把 APIRequestContext 的完整错误、请求头或代理凭据写入次数日志。
                    const detail = String(proxyError.message || '');
                    const httpStatus = detail.match(/^代理响应异常: HTTP (\d{3})$/)?.[1];
                    const reason = httpStatus ? `HTTP ${httpStatus}`
                        : /socket hang up|ECONNRESET|ERR_CONNECTION_(?:RESET|CLOSED)/i.test(detail) ? '连接被关闭或重置'
                        : /ETIMEDOUT|timed?\s*out|timeout|ERR_TIMED_OUT/i.test(detail) ? '连接超时'
                        : /ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/i.test(detail) ? '域名解析失败'
                        : /ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(detail) ? '连接被拒绝'
                        : /ERR_PROXY|ERR_TUNNEL|proxy authentication|407/i.test(detail) ? '代理认证或隧道连接失败'
                        : /TLS|SSL|certificate|ERR_CERT/i.test(detail) ? 'TLS 或证书连接失败'
                        : '网络请求未完成';
                    console.warn(`[代理检查] 第 ${attempt}/${maxProxyAttempts} 次失败：${reason}；${attempt < maxProxyAttempts ? '继续下一次连接' : '已达尝试上限，停止后续操作'}`);
                    if (attempt === maxProxyAttempts) {
                        throw Object.assign(new Error(`代理连通性检查连续 ${maxProxyAttempts} 次失败，已停止后续操作`), {
                            code: 'PROXY_CONNECTION_FAILED'
                        });
                    }
                }
            }
        }

        // --- Phase 1: Resolve payment parameters ---
        if (debugOnly) {
            console.log('[调试] 支付链接调试模式：浏览器注入 Session → API Checkout → 失败回退 UI → 到付款前停止');
        } else {
            console.log('[1] 准备自助充值流程...');
        }

        // Determine plan_type: prefer env variable, fallback to CDK lookup
        let planType = CONFIG.planType;
        const cdkCode = CONFIG.cdkCode;
        const email = CONFIG.email;

        if (cdkCode) {
            try {
                const cdkDetails = await store.verifyCdkDetails(cdkCode);
                if (cdkDetails && cdkDetails.plan_type) {
                    planType = cdkDetails.plan_type;
                }
            } catch (_) {
                // CDK lookup failed, use default
            }
        }
        if (!['go', 'plus', 'pro_5x', 'pro_20x', 'pro_500'].includes(planType)) throw new Error('未提供受支持的准确目标套餐');

        // Resolve region and currency (与浏览器 profile 一致)
        const billingCountry = paymentRegion;
        const billingCurrency = regionCfg ? regionCfg.currency : 'USD';

        console.log(`[1] 套餐类型: ${planType}, 地区: ${paymentRegion}, 币种: ${billingCurrency}`);

        validation?.stage('login');
        page = await context.newPage();
        await require('./human-verification').prepareVerificationPage?.(page, { signal: taskSignal?.() });
        safeMedia.attach(page);
        page.on('close', () => {
            console.warn(`⚠️ [系统] 当前页面已关闭，关闭前最后 URL: ${page.url()}`);
        });

        authDiagnostics = require('../subscription-diagnostics.cjs').observeAuthResponses(page, sessionRaw);
        const loginInfo = await bootstrapChatGptSession(page, sessionRaw, {
            sessionData, cookieVerified, initialSessionProbe: installResult?.initialSessionProbe, nativeSession,
            signal: taskSignal?.(), deadlineAt: performance.now() + 180000,
            onHumanVerification: verificationHandler
        });
        checkoutEvidence.bootstrapDiagnostics = loginInfo.bootstrapDiagnostics;
        if (loginInfo.email && !email) {
            console.log(`[Info] 账号邮箱: ${loginInfo.email}`);
        }

        // Account and exact tier are checked before opening a new checkout. An
        // existing subscription must follow the original plan-change UI.
        const accessToken = String(loginInfo.session?.accessToken || CONFIG.chatgptToken).trim();
        validation?.stage('preflight');
        const preflight = await require('../confirmation.cjs').preflightPayment(planType, accessToken, {
            allowUnverifiedTarget: debugOnly && !validation, browserContext: context, page, signal: taskSignal?.(), sessionRaw,
            authDiagnostics, onHumanVerification: verificationHandler
        });
        if (!preflight.allowed) {
            challengeBlocked = nativeSession && (preflight.confirmation?.queryErrorCode === 'CHALLENGE_BLOCKED'
                || preflight.confirmation?.verificationDiagnostics?.classification === 'CF_CHALLENGE');
            return { ...checkoutEvidence, success: false, submitted: false, ...preflight,
                ...(challengeBlocked ? { errorCode: 'CHALLENGE_BLOCKED', challengeDetected: true,
                    error: '官网要求进一步验证，已停止本次任务；未提交付款' } : {}) };
        }
        const operation = preflight.kind;
        if (!['initial', 'upgrade'].includes(operation)) throw new Error('无法确定首次开通或升级操作');
        const expectedCurrency = require('../confirmation.cjs').resolvePaymentCurrency(preflight, billingCurrency, { debugOnly });

        // --- Phase 2: API 创建 Checkout（注入账单地区），失败时回退 UI 定价页 ---
        const checkoutMode = String(process.env.CHECKOUT_MODE || 'api').toLowerCase();
        let checkoutOpened = false;
        let checkoutResult = null;
        const planNameOverride = String(CONFIG.planNameOverride || '').trim() || undefined;

        if (operation === 'initial' && (!debugOnly || validation)) {
            validation?.stage('card_readiness');
            await store.preflightCard();
        }
        validation?.stage('checkout_create');
        if (runOptions.checkoutPersistence?.previous
            || (checkoutMode !== 'ui' && operation === 'initial' && planType !== 'pro_500')) {
            try {
                checkoutResult = await openApiCheckout(page, {
                    accessToken: loginInfo.session?.accessToken || CONFIG.chatgptToken,
                    planType,
                    country: billingCountry,
                    currency: billingCurrency,
                    planNameOverride,
                    verifyPage: true,
                    ...(runOptions.checkoutPersistence ? { checkoutPersistence: runOptions.checkoutPersistence } : {}),
                    ...(validation ? { onCheckoutCreated: () => validation.stage('checkout_open') } : {})
                });
                checkoutOpened = true;
            } catch (apiError) {
                console.warn(`[Warn] API Checkout 失败: ${apiError.message}`);
                if (['CHECKOUT_RECOVERY_INVALID', 'CHECKOUT_RECOVERY_UNSUPPORTED'].includes(apiError.code)) throw apiError;
                // A successful or uncertain POST cannot be replaced with a new UI checkout.
                // Only a local preparation failure before any POST may use the old fallback.
                if (apiError.checkoutCreationState !== 'not_sent') throw apiError;
                if (checkoutMode === 'api') {
                    console.log('[Info] 正在回退到 UI 定价页流程...');
                } else {
                    throw apiError;
                }
            }
        }

        if (!checkoutOpened) {
            console.log('🧭 [步骤] 正在打开定价页并选择升级套餐...');
            checkoutResult = await openPricingCheckout(page, {
                region: billingCountry,
                planType,
                operation,
                debugOnly
            });
        }

        const checkoutInitialization = require('../checkout-initialization.cjs').sanitize(checkoutResult?.checkoutInitialization);
        const checkoutAwaits = require('../checkout-await-diagnostics.cjs').sanitize(checkoutResult?.checkoutAwaits);
        checkoutEvidence = { ...checkoutEvidence, ...(checkoutInitialization ? { checkoutInitialization } : {}),
            ...(checkoutAwaits ? { checkoutAwaits } : {}) };
        if (validation) {
            return { ...checkoutEvidence, ...await validation.prepare(page, { signal: taskSignal?.() }) };
        }
        if (debugOnly) {
            await waitForDebugPaymentStep(page);
            const observedDue = await require('./stripe-payment').readCheckoutDueAmount(page);
            const observedCurrency = observedDue?.currency || null;
            const pricingRegionVerified = operation === 'initial' ? checkoutResult?.pricingRegionVerified ?? null : null;
            if (pricingRegionVerified === false) {
                console.warn(`[调试] 仅观察官网付款页：配置地区 ${billingCountry} 未核验，实际应付币种 ${observedCurrency || '未识别'}；不可作为正式付款验收`);
            }
            const checkoutUrl = checkoutResult?.checkoutUrl || page.url();
            console.log(`🔗 [调试] 支付链接: ${checkoutUrl}`);
            console.log(`CHECKOUT_URL: ${checkoutUrl}`);
            console.log('CHECKOUT_DEBUG_SUCCESS');
            return { ...checkoutEvidence, success: true, debugOnly: true, checkoutUrl, requestedRegion: operation === 'initial' ? billingCountry : null, observedCurrency, pricingRegionVerified };
        }

        console.log('✅ [步骤] Checkout 页面已打开，开始信用卡支付流程...');

        const stripeSessionMatch = String(page.url() || '').match(/(oaics_[a-f0-9]+)/i);
        const stripeSessionId = stripeSessionMatch ? stripeSessionMatch[1] : null;

        // --- Phase 4: Execute Payment with Card Pool Retry ---
        console.log("[步骤] 正在使用 Stripe 信用卡卡池支付流程（单次尝试）...");
        const paymentResult = await executePaymentWithRetry(page, {
            planType,
            cdkCode,
            email,
            stripeSessionId,
            operation, preflight, expectedCurrency, checkoutKind: checkoutResult?.kind,
            paymentLimit: runOptions.paymentLimit,
            confirmPayment: (options = {}) => require('../confirmation.cjs').confirmSubscription(planType, accessToken, { browserContext: context, page, signal: taskSignal?.(), deadlineAt: options.deadlineAt })
        });

        lastPaymentResult = paymentResult;
        if (paymentResult.success) {
            paymentSucceeded = true;
            console.log(paymentResult.confirmedPaid ? '    [+] 最终校验：支付成功! (stripe_card_payment)' : '    [+] 最终校验：零应付套餐变更已生效，未记实际扣款');
            const confirmation = paymentResult.confirmation;
            if (!confirmation.verified) return { ...checkoutEvidence, ...paymentResult, success: false, resultUnknown: true, confirmedPaid: false, confirmation };
            const cancellationEmail = loginInfo.email ? loginInfo.email : email;
            const cancellationResult = await require('./upgrade-checkout').applyPostPaymentRenewalPolicy(operation, accessToken, cancellationEmail, cancelAutoRenew, {
                page, browserContext: context, signal: taskSignal?.()
            });
            if (cancellationResult) {
                if (cancellationResult.ok) console.log(`✅ [订阅] ${cancellationResult.data.message}`);
                else console.warn(`⚠️ [订阅] 支付成功，但取消自动续费失败: ${cancellationResult.error}`);
            }
            console.log(paymentResult.confirmedPaid ? "PAYMENT_SUCCESS" : "SUBSCRIPTION_CHANGE_SUCCESS");
            for (const screenshotPath of paymentResult.screenshots || []) {
                console.log(`SUCCESS_SCREENSHOT: ${screenshotPath}`);
            }
            return { ...checkoutEvidence, ...paymentResult, success: true, confirmedPaid: paymentResult.confirmedPaid === true, confirmation, operation, ...(cancellationResult ? { autoRenewCancellation: { ok: cancellationResult.ok } } : {}) };
        } else {
            const errorMsg = paymentResult.error || '支付失败（未知原因）';
            for (const screenshotPath of paymentResult.screenshots || []) {
                console.log(`FAILURE_SCREENSHOT: ${screenshotPath}`);
            }
            console.error(`❌ [支付失败] ${errorMsg} (manual_intervention)`);
            return { ...checkoutEvidence, ...paymentResult, success: false };
        }

    } catch (e) {
        if (e.checkoutOpenCleanupFailed === true || e.bootstrapCleanupFailed === true) {
            await Promise.resolve(require('./human-verification').disposeVerificationPage?.(page)).catch(() => {});
            if (context) await context.close().catch(() => {});
        }
        if (e.code === 'LEASE_LOST' || taskSignal?.()?.aborted) throw e;
        challengeBlocked = e.code === 'CHALLENGE_BLOCKED' && !wasSubmitted()
            && !require('../rpc.cjs').wasPaymentConfirmed();
        console.error("❌ [运行时错误]:", e.message);
        try {
            const errorShot = challengeBlocked || e.checkoutOpenCleanupFailed === true ? null : await captureDebugScreenshot(context, page, 'error');
            if (errorShot) {
                console.log(`FAILURE_SCREENSHOT: ${errorShot}`);
            }
        } catch (err) {
            console.error(`⚠️ [系统] 异常截图保存失败: ${err.message}`);
        }
        // 用 exitCode 而非 process.exit()，确保下方 finally 能完整执行（录像需 context 关闭后才落盘）
        const resultUnknown = wasSubmitted() || require('../rpc.cjs').wasPaymentConfirmed() || paymentSucceeded || e.code === 'RESULT_UNKNOWN';
        const proxyFailure = e.code === 'PROXY_CONNECTION_FAILED'
            ? '代理连通性检查连续 5 次失败，已停止后续操作；各次失败原因见运行日志' : undefined;
        const verificationBootstrapCode = e.bootstrapDiagnostics?.reason === 'verification_failed'
            ? require('./verification-runtime').controlledVerificationCode(e.code, null) : null;
        const bootstrapFailure = {
            PROFILE_PROXY_INVALID: '代理绑定格式无效，未继续执行',
            PROFILE_CLEANUP_FAILED: '浏览器关闭未确认，会话尚未释放',
            PROFILE_IDENTITY_MISSING: '缺少账号及用户标识，不能复用浏览器会话',
            PROFILE_BUSY: '同一账号与代理的浏览器正在使用，本次未继续',
            PROFILE_EXIT_CHANGED: '代理出口与浏览器会话绑定不一致，已停止；未切换代理',
            PROFILE_BINDING_INVALID: '浏览器出口绑定记录无效，已停止',
            PROFILE_DIRECTORY_INVALID: '浏览器会话目录无效，已停止',
            PROFILE_LAUNCH_FAILED: '专用浏览器启动未完成，请检查运行环境',
            CHALLENGE_BLOCKED: '官网要求进一步验证，已停止本次任务；未提交付款',
            CHECKOUT_AUTH_READ_FAILED: '登录控件读取失败，已停止后续操作',
            NETWORK_TIMEOUT: '官网登录核验超过本次期限，已停止后续操作',
            SESSION_NOT_CONFIRMED: '官网首页的登录状态尚未确认，已停止后续操作',
            SESSION_VERIFICATION_BLOCKED: '官网会话验证被阻断，尚未取得登录成功证据；本次未提交付款',
            SESSION_API_UNCONFIRMED: '官网首页与独立会话接口均未确认登录；本次未提交付款',
            SESSION_BOOTSTRAP_FAILED: '官网登录初始化未完成，已停止后续操作',
            SESSION_INVALID: '官网未接受本次账号登录资料，已停止后续操作',
            ACCOUNT_MISMATCH: '官网会话账号或用户与原任务不一致，已停止后续操作',
            HUMAN_VERIFICATION_REQUIRED: '官网验证尚未完成，已停止后续操作',
            HUMAN_VERIFICATION_CANCELLED: '本人验证已停止，本次未提交付款'
        }[e.code] || (verificationBootstrapCode && /^(?:VERIFICATION_|VLM_)/.test(verificationBootstrapCode)
            ? '官网验证尚未完成，已停止后续操作' : undefined);
        const bootstrapDiagnostics = bootstrapFailure
            ? require('./session-auth').safeBootstrapDiagnostics(e.bootstrapDiagnostics) : undefined;
        const checkoutFailure = {
            CHECKOUT_RECOVERY_INVALID: '原结账单来源或付款绑定无效，未提交付款',
            CHECKOUT_RECOVERY_UNSUPPORTED: '当前结账单来源尚未通过核验，未提交付款',
            CHECKOUT_CREATION_UNKNOWN: '官网建单结果未确认，已停止；未再次建单或提交付款',
            CHECKOUT_CREATION_REJECTED: e.code === 'CHECKOUT_CREATION_REJECTED'
                ? require('../checkout-creation-diagnostics.cjs').message(e.checkoutCreationDiagnostics)
                : '官网拒绝创建本次结账单，未提交付款',
            CHECKOUT_OPEN_FAILED: '原结账单已创建，页面验证未完成；未重复建单或提交付款'
        }[e.code];
        const checkoutOpenDiagnostics = checkoutFailure || e.checkoutCreationState === 'accepted'
            ? require('./chatgpt').safeCheckoutOpenDiagnostics(e.checkoutOpenDiagnostics) : undefined;
        const openStageLabels = { navigation: '支付页面导航', login: '登录页面控件读取', readiness: '支付控件检查', final_check: '结账页最终核验' };
        const openReasonLabels = { timeout: '超过本次期限', http_error: '收到异常响应', original_changed: '发现原结账单页面变化', session_required: '发现登录提示', cancelled: '已取消', network_error: '网络请求未完成', check_failed: '未通过', page_closed: '页面已关闭', not_ready: '尚未就绪', read_incomplete: '未完成', error_page: '显示官网结账错误页（原因尚未确定）' };
        const awaitDiagnostics = checkoutOpenDiagnostics?.awaits;
        const pendingRead = awaitDiagnostics?.steps.findLast(row => row.state === 'pending');
        const failedRead = awaitDiagnostics?.steps.findLast(row => row.state === 'read_failed');
        const awaitLabels = require('../checkout-await-diagnostics.cjs').LABELS;
        const readErrorLabels = { timeout: '读取超时', closed: '页面已关闭', detached: '框架已脱离', context_destroyed: '页面执行环境已替换', aborted: '读取已取消', read_failed: '读取失败' };
        const fieldLabels = { number: '卡号', expiry: '有效期', month: '有效月份', year: '有效年份', cvc: '安全码', name: '账单姓名', country: '国家', line1: '街道', city: '城市', postal: '邮编', state: '州/省' };
        const readPhaseLabels = { frame_scan: '页面扫描', candidate_handles: '候选控件获取', candidate_eligibility: '控件可交互性检查', value: '填写结果回读', control_read: '控件读取' };
        const numberCandidates = checkoutOpenDiagnostics?.candidateCounts?.find(item => item.field === 'number');
        const inspection = checkoutOpenDiagnostics?.inspection;
        const loading = checkoutOpenDiagnostics?.loading;
        const rejectionLabels = { zero_geometry: '没有显示尺寸', hidden: '隐藏属性', inert: '禁止交互',
            aria_hidden: '辅助功能隐藏', display_none: '未显示', visibility_hidden: '可见性隐藏',
            opacity_zero: '完全透明', content_visibility_hidden: '内容隐藏', aria_disabled: '辅助功能禁用',
            disabled: '控件禁用', readonly: '只读控件', excluded_type: '非填写控件', no_locator: '缺少定位标识',
            modal_background: '弹窗背景', occluded: '控件被遮挡', outside_viewport: '未进入可见区域',
            unsupported_transform: '页面变换无法核实', unsupported_geometry: '页面坐标无法核实',
            control_ineligible: '控件当前不可操作', frame_ineligible: '内嵌页面当前不可操作',
            scroll_unavailable: '无法滚动到控件', page_changed: '滚动后控件变化' };
        const rejectionSummary = (counts) => Object.entries(counts || {})
            .filter(([, count]) => count > 0).map(([key, count]) => `${rejectionLabels[key]}${count}`).join('、');
        const skippedReasons = rejectionSummary(inspection?.frameSkipCounts);
        const rejectedReasons = rejectionSummary(inspection?.controlRejectCounts);
        const interactionReasons = rejectionSummary(inspection?.interactionRejectCounts);
        const exclusionProbe = checkoutOpenDiagnostics?.exclusionProbe;
        const originLabels = { self: '自身', ancestor: '祖先容器', computed: '计算样式', none: '' };
        const excludedNumbers = exclusionProbe?.rows?.filter(row => row.field === 'number' && row.reason !== 'eligible') || [];
        const numberExclusions = excludedNumbers.slice(0, 8).map(row =>
            `${row.source === 'frame' ? '内嵌页面' : '控件'}${originLabels[row.at]}${rejectionLabels[row.reason]}${row.count}`).join('、');
        const initialization = checkoutOpenDiagnostics?.initialization;
        const initializationLabels = { stripe_script: 'Stripe脚本', stripe_frame: 'Stripe内嵌页面', stripe_elements: 'Stripe控件配置',
            stripe_init: 'Stripe原单初始化', stripe_confirm: 'Stripe确认请求', stripe_other: 'Stripe资源',
            chatgpt_checkout: '官网结账', chatgpt_auth: '官网登录资料', chatgpt_script: '官网脚本',
            chatgpt_other: '官网资源', openai_checkout: '付款页面', verification: '验证服务', other: '页面脚本或资源' };
        const initializationCodes = { DNS_FAILED: '域名解析失败', PROXY_AUTH_FAILED: '代理认证失败',
            PROXY_TUNNEL_FAILED: '代理隧道失败', TLS_FAILED: '证书或TLS连接失败', CONNECTION_RESET: '连接重置',
            CONNECTION_CLOSED: '连接关闭', CONNECTION_REFUSED: '连接拒绝', TIMEOUT: '网络超时',
            BLOCKED_BY_CLIENT: '客户端阻止', BLOCKED_BY_CSP: '内容安全策略阻止', ABORTED: '请求取消',
            NETWORK_FAILED: '网络请求失败', JS_TYPE_ERROR: '脚本类型错误', JS_SYNTAX_ERROR: '脚本语法错误',
            JS_REFERENCE_ERROR: '脚本引用错误', SCRIPT_LOAD_FAILED: '脚本加载失败', SCRIPT_ERROR: '脚本执行错误',
            SDK_INITIALIZATION_FAILED: '支付组件初始化报错', STRIPE_KEY_INVALID: '支付组件公钥配置异常',
            STRIPE_CLIENT_SECRET_INVALID: '支付组件会话参数异常', CORS_BLOCKED: '跨域策略阻止' };
        const firstInitializationFailure = initialization?.firstFailure;
        const initializationCoverage = initialization
            ? `初始化事件：共${initialization.eventCount}条，普通时间线保留${initialization.events.length}条${initialization.truncated ? '（已截断）' : ''}${initialization.version === 2 ? `；关键时间线保留${initialization.criticalEvents.length}/${initialization.criticalEventCount}条${initialization.criticalTruncated ? '（已截断）' : ''}` : '；旧记录未采集请求下载完成及待完成清单'}` : '';
        const laterInitializationFailures = initialization?.failureClasses.filter(row =>
            !['elapsedMs', 'event', 'endpoint', 'frame', 'status', 'code', 'directive', 'requestId', 'source', 'ruleId']
                .every(key => row[key] === firstInitializationFailure?.[key]))
            .slice(-4).map(row => `${row.elapsedMs}毫秒 ${initializationLabels[row.endpoint]}${row.ownerEndpoint && row.frame === 'embedded' ? `（所属${initializationLabels[row.ownerEndpoint]}）` : ''}${row.status ? ` HTTP ${row.status}` : ''}${row.code ? ` ${initializationCodes[row.code]}` : ''}${row.directive ? ` ${row.directive}` : ''}，${row.count}次`).join('；');
        const initializationDownloads = initialization?.requestCounts?.filter(row => row.endpoint.startsWith('stripe_'))
            .map(row => `${initializationLabels[row.endpoint]}：开始${row.started}、响应${row.responses}、下载完成${row.finished}、失败${row.failed}、待完成${row.pending}`).join('；');
        const pendingInitialization = initialization?.pendingRequests?.filter(row => row.endpoint.startsWith('stripe_')
            || (row.frame === 'embedded' && row.resourceType === 'script')).slice(0, 4)
            .map(row => `${initializationLabels[row.endpoint]}，${row.status ? `已收HTTP ${row.status}` : '未收响应'}，已等待${row.durationMs}毫秒`).join('；');
        const cancellationLabels = { our_route_abort: '命中本系统主动拦截', network_or_proxy: '网络或代理错误',
            unknown_abort: '取消来源尚未确认', network_other: '其他网络错误' };
        const probeFailureLabels = { timeout: '读取超时', detached: '页面已替换', closed: '页面关闭',
            context_destroyed: '页面执行环境已替换', aborted: '任务停止', read_failed: '读取失败' };
        const readIncomplete = inspection && (inspection.complete === false || inspection.framesFailed > 0
            || inspection.timedOut || inspection.pageClosed || inspection.aborted);
        const readFailures = inspection?.readFailures?.map(row =>
            `${{frame_scan: '页面扫描', frame_owner: '框架容器', load_state: '加载状态', control_snapshot: '控件快照'}[row.phase]}${probeFailureLabels[row.reason]}${row.count}`).join('、');
        const probeFailures = exclusionProbe?.failures?.map(row =>
            `${row.phase === 'frame_owner' ? '框架容器' : row.phase === 'control_snapshot' ? '控件快照' : '页面扫描'}${probeFailureLabels[row.reason]}${row.count}`).join('、');
        const diagnosticDetails = [
            initializationCoverage,
            laterInitializationFailures ? `后续观测异常（不等同根因）：${laterInitializationFailures}${initialization.failureClassesTruncated ? '；异常分类已截断' : ''}` : '',
            initializationDownloads ? `支付资源下载统计（不代表组件就绪）：${initializationDownloads}` : '',
            pendingInitialization ? `支付相关待完成请求：${pendingInitialization}` : '',
            initialization?.pendingRequestsTruncated ? `待完成清单仅保留${initialization.pendingRequests.length}/${initialization.pendingRequestCount}条` : '',
            pendingRead ? `未完成步骤：${awaitLabels[pendingRead.step]}；已等待 ${awaitDiagnostics.elapsedMs - pendingRead.startedMs} 毫秒；开始时剩余 ${pendingRead.remainingMs} 毫秒` : '',
            failedRead ? `读取失败步骤：${awaitLabels[failedRead.step]}（${readErrorLabels[failedRead.errorClass] || '读取失败'}）` : '',
            firstInitializationFailure ? `首个观测异常（不等同根因）：${initializationLabels[firstInitializationFailure.endpoint]}${firstInitializationFailure.status ? ` HTTP ${firstInitializationFailure.status}` : ''}${firstInitializationFailure.code ? ` ${initializationCodes[firstInitializationFailure.code]}` : ''}` : '',
            firstInitializationFailure?.source ? `请求失败来源：${cancellationLabels[firstInitializationFailure.source]}${firstInitializationFailure.ruleId ? `（规则 ${firstInitializationFailure.ruleId}）` : ''}${firstInitializationFailure.navigationRelated === 'possible' ? '；与同一页面导航或卸载时间接近，因果未确认' : ''}` : '',
            checkoutOpenDiagnostics?.missing?.length ? `未就绪字段：${checkoutOpenDiagnostics.missing.map(field => fieldLabels[field]).join('、')}` : '',
            readIncomplete ? '控件读取未完成，不能据此判断卡号输入框不存在' : '',
            numberCandidates ? `${readIncomplete ? '已读范围内的' : ''}卡号候选：${numberCandidates.count}（仅本次已观察范围）` : '',
            readFailures ? `控件读取异常：${readFailures}` : '',
            typeof inspection?.framesChecked === 'number' ? `已检查页面数：${inspection.framesChecked}` : '',
            inspection?.framesSkipped > 0 ? `跳过页面数：${inspection.framesSkipped}${skippedReasons ? `（${skippedReasons}）` : ''}` : '',
            typeof inspection?.controlCounts?.scanned === 'number' ? `扫描控件数：${inspection.controlCounts.scanned}` : '',
            rejectedReasons ? `控件排除原因：${rejectedReasons}` : '',
            interactionReasons ? `交互停止原因：${interactionReasons}` : '',
            numberExclusions ? `失败后卡号排除详情：${numberExclusions}` : '',
            exclusionProbe?.numberComparison ? `失败后同快照对照：现筛选语义候选${exclusionProbe.numberComparison.semanticEligible}，具备显示尺寸及可编辑状态${exclusionProbe.numberComparison.geometryEditable}（不代表允许填写）` : '',
            exclusionProbe?.complete === false ? '失败后排除诊断未完整取得' : '',
            probeFailures ? `补充读取失败：${probeFailures}` : '',
            inspection?.complete === false ? '控件读取未完成' : '',
            inspection?.framesFailed > 0 ? `读取失败页面数：${inspection.framesFailed}` : '',
            inspection?.readPhase ? `读取阶段：${readPhaseLabels[inspection.readPhase]}` : '',
            loading?.reloadAttempts ? `原单恢复次数：${loading.reloadAttempts}` : '',
            loading?.blockedWrites ? `受保护恢复拦截请求数：${loading.blockedWrites}` : ''
        ].filter(Boolean).join('；');
        const checkoutFailureMessage = checkoutOpenDiagnostics
            ? `原结账单已创建，${checkoutOpenDiagnostics.code === 'CHECKOUT_PLAN_PREPARING' ? '官网仍在准备套餐，付款表单尚未显示' : `${openStageLabels[checkoutOpenDiagnostics.stage]}${openReasonLabels[checkoutOpenDiagnostics.reason]}`}；已停止后续操作${diagnosticDetails ? `（${diagnosticDetails}）` : ''}`
            : resultUnknown && checkoutFailure ? '结账单检查未完成，付款结果待核对；已停止后续操作' : checkoutFailure;
        const debugCheckout = debugOnly && !resultUnknown && e.checkoutCreationState === 'accepted'
            && typeof e.originalCheckoutUrl === 'string'
            ? { debugOnly: true, checkoutUrl: e.originalCheckoutUrl } : {};
        return { ...checkoutEvidence, ...debugCheckout, ...(lastPaymentResult?.paymentEvidence ? { paymentEvidence: lastPaymentResult.paymentEvidence, confirmation: lastPaymentResult.confirmation, cardLast4: lastPaymentResult.cardLast4, confirmedPaid: lastPaymentResult.confirmedPaid === true, subscriptionChangedVerified: lastPaymentResult.subscriptionChangedVerified === true } : {}), success: false, ...(e.code === 'CHALLENGE_BLOCKED' && !resultUnknown ? { challengeDetected: true } : {}), ...(validation ? { validationErrorCode: e.code, formDiagnostics: validation.safeFormDiagnostics(e.formDiagnostics || { inspection: e.inspection }), validationMissing: Array.isArray(e.missing) ? e.missing.filter(key => ['number', 'expiry', 'cvc', 'country', 'line1', 'city', 'postal', 'name', 'state'].includes(key)) : undefined, challengeDetected: e.challengeDetected === true || (e.code === 'CHALLENGE_BLOCKED' && !resultUnknown) } : {}), ...(e.checkoutCreationDiagnostics ? { checkoutCreationDiagnostics: require('../checkout-creation-diagnostics.cjs').safe(e.checkoutCreationDiagnostics) } : {}), pendingCredentials: e.code === 'PENDING_CREDENTIALS', resultUnknown, ...(checkoutFailure || checkoutOpenDiagnostics || bootstrapFailure || proxyFailure ? { errorCode: proxyFailure ? 'PROXY_UNAVAILABLE' : checkoutFailure ? e.code : checkoutOpenDiagnostics ? 'CHECKOUT_OPEN_FAILED' : e.code } : {}), ...(checkoutOpenDiagnostics ? { checkoutOpenDiagnostics } : {}), ...(bootstrapDiagnostics ? { bootstrapDiagnostics } : {}), error: checkoutFailureMessage || bootstrapFailure || proxyFailure || (e.code === 'LEASE_LOST' ? '任务租约已失效' : '执行未完成，请查看受限诊断') };
    } finally {
        validation?.stage('cleanup');
        authDiagnostics?.dispose();
        console.log("👋 [系统] 流程结束，正在关闭浏览器...");
        await Promise.resolve(require('./human-verification').disposeVerificationPage?.(page)).catch(() => {});
        // 先关闭 context 以 flush 录像并取回路径，再关浏览器
        const evidence = await finalizeVideo({ fast: challengeBlocked }).catch(() => []);
        if (typeof process.send === 'function') process.send({ type: 'evidence', paths: evidence });
        if (context && !browserSession?.context) await context.close().catch(() => {});
        try { await closeTaskBrowser(browserSession, browser); }
        finally { await proxyCleanup(); }
    }
}

module.exports = { run };
if (require.main === module) run().then((result) => { process.exitCode = result?.success ? 0 : 1; }).catch(() => { process.exitCode = 1; });
