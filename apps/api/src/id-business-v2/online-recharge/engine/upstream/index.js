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
 * 1. 代理连通性检查
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
async function finalizeVideo() { return safeMedia.finish(); }

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

    let proxyCleanup = async () => { };
    let browserSession = null;
    let browser = null;
    let context = null;
    let page = null;
    let paymentSucceeded = false;
    let lastPaymentResult = null;

    const preparedProxy = await preparePlaywrightProxy(CONFIG.proxy);
    proxyCleanup = preparedProxy.cleanup;
    const proxyConfig = preparedProxy.proxyConfig;

    if (proxyConfig) {
        console.log(`🌐 [系统] 代理已配置${preparedProxy.relayed ? '（SOCKS→本地 HTTP 中继）' : ''}`);
    }

    browserSession = await connectTaskBrowser({
        proxyConfig,
        headful: DEBUG_HEADFUL,
        chromiumChannel: CHROMIUM_CHANNEL
    });
    applyCdpEnv(browserSession);
    browser = browserSession.browser;

    const realUserAgent = browserSession.realUserAgent;

    const viewport = { width: 1920, height: 1080 };
    const matched = realUserAgent.match(/Chrome\/(\d+)/);
    const chromeMajor = matched ? Number(matched[1]) : 147;

    const paymentRegion = String(CONFIG.paymentRegionOverride || '').trim().toUpperCase()
        || await store.getPaymentRegion();
    const regionCfg = getRegionConfig(paymentRegion);
    const browserProfile = getRegionBrowserProfile(paymentRegion);

    const contextOptions = {
        userAgent: realUserAgent,
        viewport,
        locale: browserProfile.locale,
        timezoneId: browserProfile.timezoneId,
        screen: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        extraHTTPHeaders: {
            'sec-ch-ua': `"Not)A;Brand";v="8", "Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}"`,
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"'
        }
    };
    if (proxyConfig) {
        contextOptions.proxy = proxyConfig;
    }

    // Actual pages are recorded only as mandatory masked screenshot frames.
    await safeMedia.start(browser);

    context = await browser.newContext(contextOptions);
    const sessionRaw = CONFIG.chatgptSessionJson || CONFIG.chatgptToken;
    const installResult = await installChatGptSession(context, sessionRaw);
    const sessionData = installResult?.sessionData || installResult;
    const cookieVerified = Boolean(installResult?.cookieVerified);

    // ============= 指纹伪装 =============
    await context.addInitScript((injectedChromeMajor) => {
        const NavProto = Object.getPrototypeOf(navigator);
        const ScrProto = Object.getPrototypeOf(screen);
        const safeDefine = (obj, key, getter) => {
            try {
                Object.defineProperty(obj, key, { get: getter, configurable: true });
            } catch (_) { /* ignore */ }
        };

        // 隐藏 webdriver
        try { delete Object.getPrototypeOf(navigator).webdriver; } catch (_) { }
        safeDefine(NavProto, 'webdriver', () => undefined);
        try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true }); } catch (_) { }

        // navigator.userAgentData
        try {
            const uaData = {
                brands: [
                    { brand: 'Not)A;Brand', version: '8' },
                    { brand: 'Chromium', version: String(injectedChromeMajor) },
                    { brand: 'Google Chrome', version: String(injectedChromeMajor) }
                ],
                mobile: false,
                platform: 'Windows',
                getHighEntropyValues: () => Promise.resolve({
                    architecture: 'x86',
                    bitness: '64',
                    mobile: false,
                    model: '',
                    platform: 'Windows',
                    platformVersion: '15.0.0',
                    wow64: false
                }),
                toJSON: () => ({ brands: uaData.brands, mobile: uaData.mobile, platform: uaData.platform })
            };
            safeDefine(NavProto, 'userAgentData', () => uaData);
        } catch (_) { }

        // plugins / mimeTypes
        try {
            const pdfMime = Object.create(MimeType.prototype);
            Object.defineProperties(pdfMime, {
                type: { get: () => 'application/pdf' },
                suffixes: { get: () => 'pdf' },
                description: { get: () => 'Portable Document Format' }
            });
            const pdfPlugin = Object.create(Plugin.prototype);
            Object.defineProperties(pdfPlugin, {
                name: { get: () => 'Chrome PDF Plugin' },
                filename: { get: () => 'internal-pdf-viewer' },
                description: { get: () => 'Portable Document Format' },
                length: { get: () => 1 },
                0: { get: () => pdfMime }
            });
            pdfPlugin.item = () => pdfMime;
            pdfPlugin.namedItem = () => pdfMime;

            const fakePlugins = Object.create(PluginArray.prototype);
            Object.defineProperties(fakePlugins, {
                length: { get: () => 1 },
                0: { get: () => pdfPlugin }
            });
            fakePlugins.item = () => pdfPlugin;
            fakePlugins.namedItem = (n) => n === pdfPlugin.name ? pdfPlugin : null;
            fakePlugins.refresh = () => { };

            const fakeMimeTypes = Object.create(MimeTypeArray.prototype);
            Object.defineProperties(fakeMimeTypes, {
                length: { get: () => 1 },
                0: { get: () => pdfMime }
            });
            fakeMimeTypes.item = () => pdfMime;
            fakeMimeTypes.namedItem = (n) => n === pdfMime.type ? pdfMime : null;

            safeDefine(NavProto, 'plugins', () => fakePlugins);
            safeDefine(NavProto, 'mimeTypes', () => fakeMimeTypes);
        } catch (_) { }

        // 语言、平台、硬件
        safeDefine(NavProto, 'languages', () => ['en-US', 'en']);
        safeDefine(NavProto, 'language', () => 'en-US');
        safeDefine(NavProto, 'platform', () => 'Win32');
        safeDefine(NavProto, 'hardwareConcurrency', () => 8);
        safeDefine(NavProto, 'deviceMemory', () => 8);
        safeDefine(NavProto, 'maxTouchPoints', () => 0);
        safeDefine(NavProto, 'vendor', () => 'Google Inc.');

        // navigator.connection
        try {
            const conn = { effectiveType: '4g', rtt: 100, downlink: 10, saveData: false };
            safeDefine(NavProto, 'connection', () => conn);
        } catch (_) { }

        // window.chrome
        try {
            const fakeChrome = {
                app: {
                    isInstalled: false,
                    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
                    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
                    getDetails: () => null,
                    getIsInstalled: () => false
                },
                runtime: {
                    OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
                    OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
                    PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
                    PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
                    PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
                    RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
                    connect: () => { },
                    sendMessage: () => { }
                },
                csi: () => ({ onloadT: Date.now(), pageT: Date.now() - 1000, startE: Date.now() - 2000, tran: 15 }),
                loadTimes: () => ({
                    requestTime: Date.now() / 1000 - 2,
                    startLoadTime: Date.now() / 1000 - 1.5,
                    commitLoadTime: Date.now() / 1000 - 1,
                    finishDocumentLoadTime: Date.now() / 1000 - 0.5,
                    finishLoadTime: Date.now() / 1000,
                    firstPaintTime: Date.now() / 1000 - 0.3,
                    firstPaintAfterLoadTime: 0,
                    navigationType: 'Other',
                    wasFetchedViaSpdy: true,
                    wasNpnNegotiated: true,
                    npnNegotiatedProtocol: 'h2',
                    wasAlternateProtocolAvailable: false,
                    connectionInfo: 'h2'
                })
            };
            Object.defineProperty(window, 'chrome', { value: fakeChrome, writable: true, configurable: true });
        } catch (_) { }

        // permissions.query
        try {
            const origQuery = navigator.permissions.query.bind(navigator.permissions);
            navigator.permissions.query = (params) => {
                if (params && params.name === 'notifications') {
                    return Promise.resolve({ state: typeof Notification !== 'undefined' ? Notification.permission : 'default', onchange: null });
                }
                return origQuery(params).catch(() => ({ state: 'prompt', onchange: null }));
            };
        } catch (_) { }

        // screen
        safeDefine(ScrProto, 'availHeight', () => 1032);
        safeDefine(ScrProto, 'availWidth', () => 1920);
        safeDefine(ScrProto, 'colorDepth', () => 24);
        safeDefine(ScrProto, 'pixelDepth', () => 24);
        safeDefine(ScrProto, 'width', () => 1920);
        safeDefine(ScrProto, 'height', () => 1080);

        // Canvas 微噪声
        try {
            const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function (...args) {
                const ctx = this.getContext('2d');
                if (ctx) {
                    try {
                        const w = this.width, h = this.height;
                        if (w > 0 && h > 0) {
                            const data = ctx.getImageData(0, 0, 1, 1);
                            data.data[3] = Math.max(1, data.data[3] - 1);
                            ctx.putImageData(data, 0, 0);
                        }
                    } catch (_) { }
                }
                return origToDataURL.apply(this, args);
            };
        } catch (_) { }

        // WebGL
        try {
            const fakeWebGL = (gl) => {
                const origGetParameter = gl.getParameter.bind(gl);
                gl.getParameter = function (param) {
                    if (param === 0x9245) return 'Google Inc. (Intel)';
                    if (param === 0x9246) return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                    return origGetParameter(param);
                };
            };
            const origGetCtx = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type, ...args) {
                const ctx = origGetCtx.call(this, type, ...args);
                if (ctx && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
                    try { fakeWebGL(ctx); } catch (_) { }
                }
                return ctx;
            };
        } catch (_) { }

        // ChromeDriver 痕迹
        try {
            for (const key of Object.keys(window)) {
                if (/^(cdc_|\$cdc_|_phantom|callPhantom|webdriver-|driver-)/.test(key)) {
                    try { delete window[key]; } catch (_) { }
                }
            }
        } catch (_) { }

        // Notification.permission
        try {
            if (typeof Notification !== 'undefined') {
                Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });
            }
        } catch (_) { }
    }, chromeMajor);

    try {
        // --- Phase 0: Proxy Connectivity Check ---
        if (proxyConfig) {
            console.log('正在检查代理连通性...');
            try {
                const probeResponse = await context.request.get("http://api.ipify.org/?format=text", {
                    timeout: 15000
                });
                if (probeResponse.ok()) {
                    const ip = (await probeResponse.text()).trim();
                    console.log(`✅ [系统] 代理连接成功! 代理公网 IP: ${ip}`);
                } else {
                    throw new Error(`代理响应异常: HTTP ${probeResponse.status()}`);
                }
            } catch (proxyError) {
                console.log("    [!] 请检查 PROXY 配置是否正确，或者账号余额是否充足。");
                throw proxyError;
            }
        }

        // --- Phase 1: Resolve payment parameters ---
        const debugOnly = process.env.CHECKOUT_DEBUG_ONLY === '1';
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
        if (!['plus', 'pro_5x', 'pro_20x', 'pro_500'].includes(planType)) throw new Error('未提供受支持的准确目标套餐');

        // Resolve region and currency (与浏览器 profile 一致)
        const billingCountry = paymentRegion;
        const billingCurrency = regionCfg ? regionCfg.currency : 'USD';

        console.log(`[1] 套餐类型: ${planType}, 地区: ${paymentRegion}, 币种: ${billingCurrency}`);

        page = await context.newPage();
        await require('./human-verification').prepareVerificationPage?.(page, { signal: taskSignal?.() });
        safeMedia.attach(page);
        page.on('close', () => {
            console.warn(`⚠️ [系统] 当前页面已关闭，关闭前最后 URL: ${page.url()}`);
        });

        const loginInfo = await bootstrapChatGptSession(page, sessionRaw, {
            sessionData, cookieVerified, signal: taskSignal?.(), deadlineAt: performance.now() + 180000
        });
        if (loginInfo.email && !email) {
            console.log(`[Info] 账号邮箱: ${loginInfo.email}`);
        }

        // Account and exact tier are checked before opening a new checkout. An
        // existing subscription must follow the original plan-change UI.
        const accessToken = String(loginInfo.session?.accessToken || CONFIG.chatgptToken).trim();
        const preflight = await require('../confirmation.cjs').preflightPayment(planType, accessToken, { allowUnverifiedTarget: debugOnly, browserContext: context, page, signal: taskSignal?.() });
        if (!preflight.allowed) return { success: false, submitted: false, ...preflight };
        const operation = preflight.kind;
        if (!['initial', 'upgrade'].includes(operation)) throw new Error('无法确定首次开通或升级操作');
        const expectedCurrency = require('../confirmation.cjs').resolvePaymentCurrency(preflight, billingCurrency, { debugOnly });

        // --- Phase 2: API 创建 Checkout（注入账单地区），失败时回退 UI 定价页 ---
        const checkoutMode = String(process.env.CHECKOUT_MODE || 'api').toLowerCase();
        let checkoutOpened = false;
        let checkoutResult = null;
        const planNameOverride = String(CONFIG.planNameOverride || '').trim() || undefined;

        if (checkoutMode !== 'ui' && operation === 'initial' && planType !== 'pro_500') {
            try {
                checkoutResult = await openApiCheckout(page, {
                    accessToken: loginInfo.session?.accessToken || CONFIG.chatgptToken,
                    planType,
                    country: billingCountry,
                    currency: billingCurrency,
                    planNameOverride,
                    verifyPage: true
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
            return { success: true, debugOnly: true, checkoutUrl, requestedRegion: operation === 'initial' ? billingCountry : null, observedCurrency, pricingRegionVerified };
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
            if (!confirmation.verified) return { ...paymentResult, success: false, resultUnknown: true, confirmedPaid: false, confirmation };
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
            return { ...paymentResult, success: true, confirmedPaid: paymentResult.confirmedPaid === true, confirmation, operation, ...(cancellationResult ? { autoRenewCancellation: { ok: cancellationResult.ok } } : {}) };
        } else {
            const errorMsg = paymentResult.error || '支付失败（未知原因）';
            for (const screenshotPath of paymentResult.screenshots || []) {
                console.log(`FAILURE_SCREENSHOT: ${screenshotPath}`);
            }
            console.error(`❌ [支付失败] ${errorMsg} (manual_intervention)`);
            return { ...paymentResult, success: false };
        }

    } catch (e) {
        if (e.checkoutOpenCleanupFailed === true) {
            await Promise.resolve(require('./human-verification').disposeVerificationPage?.(page)).catch(() => {});
            if (context) await context.close().catch(() => {});
        }
        if (e.code === 'LEASE_LOST' || taskSignal?.()?.aborted) throw e;
        console.error("❌ [运行时错误]:", e.message);
        try {
            const errorShot = e.checkoutOpenCleanupFailed === true ? null : await captureDebugScreenshot(context, page, 'error');
            if (errorShot) {
                console.log(`FAILURE_SCREENSHOT: ${errorShot}`);
            }
        } catch (err) {
            console.error(`⚠️ [系统] 异常截图保存失败: ${err.message}`);
        }
        // 用 exitCode 而非 process.exit()，确保下方 finally 能完整执行（录像需 context 关闭后才落盘）
        const resultUnknown = wasSubmitted() || require('../rpc.cjs').wasPaymentConfirmed() || paymentSucceeded || e.code === 'RESULT_UNKNOWN';
        const verificationBootstrapCode = e.bootstrapDiagnostics?.reason === 'verification_failed'
            ? require('./verification-runtime').controlledVerificationCode(e.code, null) : null;
        const bootstrapFailure = {
            SESSION_NOT_CONFIRMED: '官网首页的登录状态尚未确认，已停止后续操作',
            SESSION_BOOTSTRAP_FAILED: '官网登录初始化未完成，已停止后续操作',
            SESSION_INVALID: '官网未接受本次账号登录资料，已停止后续操作',
            ACCOUNT_MISMATCH: '官网会话账号或用户与原任务不一致，已停止后续操作',
            HUMAN_VERIFICATION_REQUIRED: '官网验证尚未完成，已停止后续操作'
        }[e.code] || (verificationBootstrapCode && /^(?:VERIFICATION_|VLM_)/.test(verificationBootstrapCode)
            ? '官网验证尚未完成，已停止后续操作' : undefined);
        const bootstrapDiagnostics = bootstrapFailure
            ? require('./session-auth').safeBootstrapDiagnostics(e.bootstrapDiagnostics) : undefined;
        const checkoutFailure = {
            CHECKOUT_RECOVERY_INVALID: '原结账单来源或付款绑定无效，未提交付款',
            CHECKOUT_RECOVERY_UNSUPPORTED: '当前结账单来源尚未通过核验，未提交付款',
            CHECKOUT_CREATION_UNKNOWN: '官网建单结果未确认，已停止；未再次建单或提交付款',
            CHECKOUT_CREATION_REJECTED: '官网拒绝创建本次结账单，未提交付款',
            CHECKOUT_OPEN_FAILED: '原结账单已创建，页面验证未完成；未重复建单或提交付款'
        }[e.code];
        const checkoutOpenDiagnostics = checkoutFailure || e.checkoutCreationState === 'accepted'
            ? require('./chatgpt').safeCheckoutOpenDiagnostics(e.checkoutOpenDiagnostics) : undefined;
        const openStageLabels = { navigation: '支付页面导航', login: '登录核验', readiness: '支付控件检查', final_check: '结账页最终核验' };
        const openReasonLabels = { timeout: '超过本次期限', http_error: '收到异常响应', original_changed: '发现原结账单页面变化', session_required: '未通过', cancelled: '已取消', network_error: '网络请求未完成', check_failed: '未通过', page_closed: '页面已关闭', not_ready: '尚未就绪' };
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
        const diagnosticDetails = [
            checkoutOpenDiagnostics?.missing?.length ? `未就绪字段：${checkoutOpenDiagnostics.missing.map(field => fieldLabels[field]).join('、')}` : '',
            numberCandidates ? `卡号候选：${numberCandidates.count}` : '',
            typeof inspection?.framesChecked === 'number' ? `已检查页面数：${inspection.framesChecked}` : '',
            inspection?.framesSkipped > 0 ? `跳过页面数：${inspection.framesSkipped}${skippedReasons ? `（${skippedReasons}）` : ''}` : '',
            typeof inspection?.controlCounts?.scanned === 'number' ? `扫描控件数：${inspection.controlCounts.scanned}` : '',
            rejectedReasons ? `控件排除原因：${rejectedReasons}` : '',
            interactionReasons ? `交互停止原因：${interactionReasons}` : '',
            numberExclusions ? `失败后卡号排除详情：${numberExclusions}` : '',
            exclusionProbe?.numberComparison ? `失败后同快照对照：现筛选语义候选${exclusionProbe.numberComparison.semanticEligible}，具备显示尺寸及可编辑状态${exclusionProbe.numberComparison.geometryEditable}（不代表允许填写）` : '',
            exclusionProbe?.complete === false ? '失败后排除诊断未完整取得' : '',
            inspection?.complete === false ? '控件读取未完成' : '',
            inspection?.framesFailed > 0 ? `读取失败页面数：${inspection.framesFailed}` : '',
            inspection?.readPhase ? `读取阶段：${readPhaseLabels[inspection.readPhase]}` : '',
            loading?.reloadAttempts ? `原单恢复次数：${loading.reloadAttempts}` : '',
            loading?.blockedWrites ? `受保护恢复拦截请求数：${loading.blockedWrites}` : ''
        ].filter(Boolean).join('；');
        const checkoutFailureMessage = checkoutOpenDiagnostics
            ? `原结账单已创建，${openStageLabels[checkoutOpenDiagnostics.stage]}${openReasonLabels[checkoutOpenDiagnostics.reason]}；已停止后续操作${diagnosticDetails ? `（${diagnosticDetails}）` : ''}`
            : resultUnknown && checkoutFailure ? '结账单检查未完成，付款结果待核对；已停止后续操作' : checkoutFailure;
        return { ...(lastPaymentResult?.paymentEvidence ? { paymentEvidence: lastPaymentResult.paymentEvidence, confirmation: lastPaymentResult.confirmation, cardLast4: lastPaymentResult.cardLast4, confirmedPaid: lastPaymentResult.confirmedPaid === true, subscriptionChangedVerified: lastPaymentResult.subscriptionChangedVerified === true } : {}), success: false, pendingCredentials: e.code === 'PENDING_CREDENTIALS', resultUnknown, ...(checkoutFailure || checkoutOpenDiagnostics || bootstrapFailure ? { errorCode: checkoutFailure ? e.code : checkoutOpenDiagnostics ? 'CHECKOUT_OPEN_FAILED' : e.code } : {}), ...(checkoutOpenDiagnostics ? { checkoutOpenDiagnostics } : {}), ...(bootstrapDiagnostics ? { bootstrapDiagnostics } : {}), error: checkoutFailureMessage || bootstrapFailure || (e.code === 'LEASE_LOST' ? '任务租约已失效' : '执行未完成，请查看受限诊断') };
    } finally {
        console.log("👋 [系统] 流程结束，正在关闭浏览器...");
        await Promise.resolve(require('./human-verification').disposeVerificationPage?.(page)).catch(() => {});
        // 先关闭 context 以 flush 录像并取回路径，再关浏览器
        const evidence = await finalizeVideo(context, page, { deleteOnSuccess: paymentSucceeded }).catch(() => []);
        if (typeof process.send === 'function') process.send({ type: 'evidence', paths: evidence });
        if (context) await context.close().catch(() => {});
        await closeTaskBrowser(browserSession, browser);
        await proxyCleanup();
    }
}

module.exports = { run };
if (require.main === module) run().then((result) => { process.exitCode = result?.success ? 0 : 1; }).catch(() => { process.exitCode = 1; });
