#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const ADMIN_BASE_URL = String(
  process.env.V2_PERF_ADMIN_BASE_URL ?? 'http://127.0.0.1:5374'
).replace(/\/$/, '');
const HTTP_TIMEOUT_MS = 30_000;
const RESOURCE_DELAY_MS = Number(process.env.V2_PERF_RESOURCE_DELAY_MS ?? 400);
const API_DELAY_MS = Number(process.env.V2_PERF_API_DELAY_MS ?? 600);
const ALLOW_REMOTE_PREVIEW = process.env.V2_PERF_ALLOW_REMOTE === 'true';
const REPORT_METRICS = process.env.V2_PERF_REPORT_METRICS === 'true';
const navigationMetrics = [];
const ALL_V2_PATHS = [
  '/v2/workbench/renewals',
  '/v2/workbench/order-entry',
  '/v2/workbench/topups',
  '/v2/accounts',
  '/v2/orders',
  '/v2/customers',
  '/v2/records/topups',
  '/v2/records/activations',
  '/v2/exchange-rates',
  '/v2/options'
];
const rootDir = new URL('..', import.meta.url);

loadEnvFile(new URL('.env', rootDir));
loadEnvFile(new URL('apps/api/.env', rootDir));

checkSourceContracts();
checkBuildBudgets();
await checkBrowserRuntime();

console.log(
  '[V2 navigation performance] PASSED: 同步外壳、意图预取、分阶段性能指标、Chunk 恢复、内容形状骨架、单一读取反馈、回访缓存、失败保留、状态连续性、桌面与移动端均符合验收要求'
);

function loadEnvFile(fileUrl) {
  try {
    for (const line of readFileSync(fileUrl, 'utf8').split(/\r?\n/)) {
      const normalized = line.trim();
      if (!normalized || normalized.startsWith('#')) continue;
      const separator = normalized.indexOf('=');
      if (separator < 0) continue;
      process.env[normalized.slice(0, separator)] ??= normalized.slice(separator + 1);
    }
  } catch {
    // Missing credentials are reported before browser login.
  }
}

function checkSourceContracts() {
  const html = read('apps/admin/index.html');
  const entry = read('apps/admin/src/main.ts');
  const app = read('apps/admin/src/App.vue');
  const appRuntimeError = read('apps/admin/src/runtime/appRuntimeError.ts');
  const auth = read('apps/admin/src/stores/auth.ts');
  const sessionCoordinator = read('apps/admin/src/auth/sessionCoordinator.ts');
  const layout = read('apps/admin/src/v2/layouts/V2AdminLayout.vue');
  const performanceRuntime = read('apps/admin/src/runtime/performance.ts');
  const routes = read('apps/admin/src/v2/router/routes.ts');
  const recovery = read('apps/admin/src/v2/runtime/preloadRecovery.ts');
  const routePrefetch = read('apps/admin/src/v2/runtime/routePrefetch.ts');
  const router = read('apps/admin/src/v2-router.ts');
  const viteConfig = read('apps/admin/vite.config.ts');
  const query = read('apps/admin/src/v2/composables/useV2Query.ts');
  const changeSync = read('apps/admin/src/v2/runtime/changeSync.ts');
  const changeSyncPolicy = read('apps/admin/src/v2/runtime/changeSyncPolicy.ts');
  const pageState = read('apps/admin/src/v2/components/V2PageState.vue');
  const asyncRegion = read('apps/admin/src/v2/components/V2AsyncRegion.vue');
  const asyncRegionState = read('apps/admin/src/v2/components/asyncRegionState.ts');
  const contentSkeleton = read('apps/admin/src/v2/components/V2ContentSkeleton.vue');
  const loadingVisuals = read('apps/admin/src/v2/components/loadingVisuals.ts');
  const orderEntryManifest = read('apps/admin/src/v2/features/order-entry/manifest.ts');
  const optionsApi = read('apps/admin/src/v2/api/options.ts');
  const optionsView = read('apps/admin/src/v2/features/options/V2OptionsView.vue');
  const optionsList = read('apps/admin/src/v2/features/options/components/V2OptionsList.vue');
  const ordersApi = read('apps/admin/src/v2/api/orders.ts');
  const ordersPage = read('apps/admin/src/v2/features/orders/useOrdersPage.ts');
  const renewalsApi = read('apps/admin/src/v2/api/renewals.ts');
  const renewalsPage = read('apps/admin/src/v2/features/renewals/useRenewalsPage.ts');
  const routedPageSources = [
    ['续费', renewalsPage],
    [
      '订单录入',
      `${read('apps/admin/src/v2/features/order-entry/useOrderEntryPage.ts')}\n${read(
        'apps/admin/src/v2/features/order-entry/useOrderEntryOptionsQuery.ts'
      )}`
    ],
    [
      '加卡',
      `${read('apps/admin/src/v2/features/topups/useTopupWorkbenchPage.ts')}\n${read(
        'apps/admin/src/v2/features/topups/topup-query.ts'
      )}`
    ],
    [
      'ID',
      `${read('apps/admin/src/v2/features/accounts/useAccountsPage.ts')}\n${read(
        'apps/admin/src/v2/features/accounts/accounts-query.ts'
      )}`
    ],
    ['订单', ordersPage],
    ['客户', read('apps/admin/src/v2/features/customers/useCustomersPage.ts')],
    ['加卡记录', read('apps/admin/src/v2/features/topup-records/useTopupRecordsPage.ts')],
    ['开通记录', read('apps/admin/src/v2/features/activations/useActivationsPage.ts')],
    ['汇率', read('apps/admin/src/v2/features/exchange-rates/useExchangeRatesPage.ts')],
    ['选项', read('apps/admin/src/v2/features/options/useOptionsPage.ts')]
  ];
  const readApiSources = [
    'accounts',
    'activations',
    'balances',
    'customers',
    'exchangeRates',
    'options',
    'orders',
    'renewals'
  ].map((name) => [name, read(`apps/admin/src/v2/api/${name}.ts`)]);

  assert.match(html, /class="v2-boot"/, 'V2 HTML 缺少同步启动外壳');
  assert.doesNotMatch(html, /v2-boot__sidebar|v2-boot__nav/, 'V2 HTML 仍伪造工作区');
  assert.match(entry, /import\s+\{[^}]*createApp[^}]*\}\s+from\s+['"]vue['"]/, 'Vue 未静态导入');
  assert.match(entry, /import\s+App\s+from/, 'App 未静态导入');
  assert.doesNotMatch(
    entry,
    /\bawait\s+[^;]*(?:initializeSession|ensureSessionReady|router\.isReady)/s,
    'V2 mount 仍被鉴权或路由阻塞'
  );
  assert.doesNotMatch(
    entry,
    /elementPlusPlugin|preloadElementPlusComponents/,
    'V2 仍依赖旧 Element Plus 运行时预加载'
  );
  assert.doesNotMatch(entry, /element-plus\/dist\/index\.css/, 'V2 仍在加载 Element Plus 全量 CSS');
  assert.doesNotMatch(entry, /\.\/styles\/main\.css/, '当前入口不得加载已停用的 main.css');
  assert.match(layout, /:aria-busy="isRoutePending"/, '内容区缺少 aria-busy');
  assert.doesNotMatch(layout, /后台更新中|上次更新失败/, '布局仍复制区域读取反馈');
  assert.doesNotMatch(layout, /scheduleIdlePrefetch|requestIdleCallback/, '布局仍批量预取全部页面');
  assert.match(layout, /createV2RoutePrefetchController/, '布局缺少统一意图预取控制器');
  assert.match(layout, /@pointerenter=/, '导航缺少鼠标悬停意图预取');
  assert.match(layout, /@pointerleave=/, '导航离开后没有取消未开始的预取');
  assert.match(layout, /@focus=/, '导航缺少键盘聚焦意图预取');
  assert.match(layout, /@pointerdown=/, '导航确认时缺少即时目标预取');
  assert.doesNotMatch(layout, /<Transition\s+name="v2-route"/, '整页交叉动画仍然存在');
  assert.match(routes, /export async function prefetchV2Route/, '路由预取注册表缺失');
  assert.match(routes, /markV2RoutePrefetch/, '路由预取缺少性能观测');
  assert.doesNotMatch(
    routes,
    /plugins\/element-plus|V2_WORKSPACE_COMPONENTS|V2_LOGIN_COMPONENTS/,
    '路由仍预加载完整 Element Plus 组件合集'
  );
  assert.match(
    auth,
    /ensureSessionReady:\s*sessionCoordinator\.ensureSession/,
    'auth store 缺少统一会话门映射'
  );
  assert.match(
    sessionCoordinator,
    /async function ensureSession\s*\(/,
    '统一会话协调器缺少会话门实现'
  );
  assert.match(
    sessionCoordinator,
    /if \(validationPromise\) return validationPromise/,
    '会话门缺少进行中 Promise 复用'
  );
  for (const stage of [
    'booting',
    'session-checking',
    'route-loading',
    'ready',
    'degraded',
    'fatal'
  ]) {
    assert.ok(app.includes(`'${stage}'`), `V2 Boot Gate 缺少 ${stage} 状态`);
  }
  assert.doesNotMatch(app, /currentRouteLoadError/, '路由错误仍触发 V2App 全屏遮罩');
  assert.match(appRuntimeError, /isApiError/, '应用错误边界没有识别结构化 API 错误');
  assert.match(appRuntimeError, /isNavigationFailure/, '应用错误边界没有识别结构化路由失败');
  assert.doesNotMatch(
    appRuntimeError,
    /failed to fetch dynamically imported module|couldn't resolve component/i,
    '应用错误边界仍依赖不稳定的浏览器错误文案'
  );
  assert.match(recovery, /vite:preloadError/, '缺少 Vite preload error 恢复');
  assert.match(recovery, /sessionStorage/, 'Chunk 恢复缺少会话级防循环记录');
  assert.match(recovery, /defer-to-router/, '稳定页面 Chunk 失败没有交还路由或意图调用方');
  assert.match(routePrefetch, /V2_HOVER_PREFETCH_DELAY_MS/, '悬停预取缺少意图延迟');
  assert.match(routePrefetch, /connection\?\.saveData/, '预取没有尊重省流量设置');
  assert.match(routePrefetch, /slow-2g[\s\S]*2g/, '预取没有规避慢速网络');
  assert.match(performanceRuntime, /v2:route-code-ready/, '缺少路由代码就绪指标');
  assert.match(performanceRuntime, /v2:route-data-ready/, '缺少业务数据就绪指标');
  assert.match(
    performanceRuntime,
    /v2:route-code-to-data-duration/,
    '缺少代码就绪到数据就绪的耗时'
  );
  assert.doesNotMatch(
    performanceRuntime,
    /'v2:route-ready'/,
    '仍使用含糊的 route-ready 冒充业务数据就绪'
  );
  assert.match(router, /beginV2RoutePerformance\(to\.path\)/, '路由开始没有性能代际');
  assert.match(router, /markV2RouteCodeReady/, 'afterEach 没有只记录路由代码就绪');
  assert.match(viteConfig, /ElementPlusResolver/, 'V2 未配置 Element Plus 官方按需解析器');
  assert.doesNotMatch(query, /TIER_FRESHNESS_MS|critical:\s*15_000/, '查询缓存仍使用固定 TTL');
  assert.match(query, /entry\.invalidated/, '查询缓存缺少精确失效状态');
  assert.match(query, /entry\.revalidateAt/, '时间语义查询缺少 deadline');
  assert.match(query, /MAX_INACTIVE_QUERY_ENTRIES = 200/, '查询缓存缺少 200 条 LRU 保护');
  assert.match(query, /INVALIDATION_COALESCE_MS = 100/, '查询失效没有在 100ms 内合并');
  assert.match(query, /entry\.inFlight/, '同查询请求去重缺失');
  assert.match(query, /getAuthIdentityEpoch/, '查询缓存缺少身份代际隔离');
  assert.match(query, /entry\.revision/, '失效请求缺少旧响应回写保护');
  assert.match(query, /isPlaceholderData/, '查询缓存缺少保留上一份成功内容的状态');
  assert.match(query, /export function primeV2Query/, '查询缓存缺少 bootstrap 预填能力');
  assert.match(query, /export function useV2ModuleQuery/, 'V2 页面缺少真实数据查询入口');
  assert.match(query, /syncFromEntry\(initialEntry\)/, '查询消费者创建时没有同步读取已有缓存');
  assert.match(query, /markV2RouteDataReady/, '真实模块查询没有上报业务数据就绪');
  assert.match(query, /markV2RouteDataError/, '首次数据失败没有结束性能等待');
  assert.doesNotMatch(
    query,
    /localStorage|sessionStorage|indexedDB/i,
    '敏感业务查询缓存被写入浏览器持久化存储'
  );
  assert.match(changeSync, /id-business-v2:changes/, '缺少 V2 私有实时主题');
  assert.match(
    changeSync,
    /HEALTHY_RECONCILE_INTERVAL_MS = 5 \* 60 \* 1000/,
    '健康校验不是 5 分钟'
  );
  assert.match(
    changeSyncPolicy,
    /V2_DEGRADED_RECONCILE_INTERVAL_MS = 15_000/,
    '降级校验不是 15 秒'
  );
  assert.match(changeSync, /document\.visibilityState/, '版本补偿缺少标签页可见性处理');
  assert.match(changeSync, /window\.addEventListener\('online'/, '版本补偿缺少恢复联网处理');
  assert.doesNotMatch(
    `${entry}\n${viteConfig}`,
    /serviceWorker|navigator\.serviceWorker|workbox/i,
    'V2 加载架构不得引入 Service Worker 或 PWA 缓存'
  );
  assert.match(asyncRegion, /REFRESH_FEEDBACK_DELAY_MS = 120/, '统一区域反馈延迟不是 120ms');
  assert.match(asyncRegion, /showRefreshFeedback/, '统一区域缺少保留内容的刷新反馈');
  assert.match(
    asyncRegionState,
    /return phase === 'refreshing' \|\| phase === 'transitioning'/,
    '刷新反馈没有限制为已有成功内容'
  );
  assert.match(asyncRegion, /v2-async-region__progress/, '读取刷新没有使用统一顶部进度线');
  assert.doesNotMatch(
    asyncRegion,
    /v2-async-region__(?:overlay|spinner)/,
    '读取刷新仍在使用浮动卡片或重复旋转指示器'
  );
  assert.match(pageState, /V2ContentSkeleton/, '首次加载没有委托给统一内容形状骨架');
  assert.doesNotMatch(
    pageState,
    /skeleton-toolbar|skeleton-table/,
    '页面状态仍写死同一套筛选栏和表格骨架'
  );
  for (const kind of ['table', 'form', 'metrics', 'settings', 'detail', 'cards', 'inline']) {
    assert.ok(loadingVisuals.includes(`'${kind}'`), `缺少 ${kind} 内容骨架类型`);
    assert.ok(
      contentSkeleton.includes(`kind === '${kind}'`) || kind === 'inline',
      `骨架组件缺少 ${kind}`
    );
  }
  assert.match(contentSkeleton, /prefers-reduced-motion/, '骨架动画没有适配减少动态效果');
  assert.match(optionsApi, /listsByType/, '选项 bootstrap 没有预填九类列表缓存');
  assert.match(optionsApi, /force:\s*options\.force/, '选项列表缺少强制刷新能力');
  assert.match(optionsList, /:key="page\.renderedType"/, '选项表格仍在请求完成前按选择类型重建');
  assert.match(optionsView, /V2AsyncRegion/, '选项切换没有使用统一异步区域');
  for (const [label, source] of routedPageSources) {
    assert.match(source, /useV2ModuleQuery/, `${label}页面没有接入真实数据查询缓存`);
    assert.match(source, /createV2QueryKey/, `${label}页面没有使用规范化查询 key`);
    assert.doesNotMatch(source, /useV2ModuleRefresh/, `${label}页面仍使用旧完成标记缓存`);
  }
  for (const [label, source] of readApiSources) {
    assert.doesNotMatch(source, /latestV2Request/, `${label}读取 API 仍通过固定通道互相取消`);
  }
  assert.match(orderEntryManifest, /keepAlive:\s*true/, '订单录入没有声明内存草稿保留');
  assert.match(layout, /viewRoute\.meta\.keepAlive/, '布局没有执行选择性 KeepAlive');
  assert.doesNotMatch(
    layout,
    /V2_PAGE_CACHE_LIMIT\s*=\s*v2ModuleDefinitions\.length/,
    '布局仍缓存全部 V2 页面实例'
  );
  assert.match(ordersApi, /options:\s*ApiRequestOptions/, '订单读取 API 不接受查询层中止信号');
  assert.doesNotMatch(
    ordersApi,
    /latestV2Request\('orders:(?:list|bootstrap)'/,
    '订单不同查询 key 仍会通过固定通道互相取消'
  );
  assert.match(renewalsApi, /options:\s*ApiRequestOptions/, '续费读取 API 不接受查询层中止信号');
  assert.doesNotMatch(
    renewalsApi,
    /latestV2Request\('renewals:(?:workbench|bootstrap)'/,
    '续费不同查询 key 仍会通过固定通道互相取消'
  );
  assert.doesNotMatch(pageState, /<el-skeleton/, '页面首个骨架仍依赖异步 Element 组件');

  const v2VueSources = collectVueSources('apps/admin/src/v2');
  let asyncRegionCount = 0;
  for (const [file, source] of v2VueSources) {
    for (const match of source.matchAll(/<V2AsyncRegion\b[\s\S]*?>/g)) {
      asyncRegionCount += 1;
      assert.match(
        match[0],
        /\bskeleton=["'](?:table|form|metrics|settings|detail|cards|inline)["']/,
        `${file} 的异步区域没有显式内容形状`
      );
    }
    for (const match of source.matchAll(/<AppButton\b[\s\S]*?>/g)) {
      if (/\btitle=["'][^"']*刷新[^"']*["']/.test(match[0])) {
        assert.doesNotMatch(match[0], /\b:loading=/, `${file} 的读取刷新按钮仍显示第二个 loading`);
      }
    }
  }
  assert.ok(asyncRegionCount >= 20, `只发现 ${asyncRegionCount} 个内容形状异步区域`);

  const viewFiles = readdirSync(new URL('apps/admin/src/v2/views', rootDir)).filter((file) =>
    file.endsWith('.vue')
  );
  for (const file of viewFiles) {
    const source = read(`apps/admin/src/v2/views/${file}`);
    assert.doesNotMatch(
      source,
      /import\s+\{[^}]*El(?:Message|MessageBox)[^}]*\}\s+from\s+['"]element-plus['"]/s,
      `${file} 仍有 Element Plus 桶式运行时导入`
    );
    assert.doesNotMatch(
      source,
      /onActivated\s*\(\s*(?:load|startPolling\s*\(\s*\)\s*;?\s*void\s+load)/,
      `${file} 仍在激活时无条件整页加载`
    );
  }
}

function checkBuildBudgets() {
  const distDir = new URL('apps/admin/dist/', rootDir);
  const indexPath = new URL('index.html', distDir);
  assert.ok(existsSync(indexPath), '缺少管理端构建产物，请先运行 build');
  const html = readFileSync(indexPath, 'utf8');
  const linkedAssets = [
    ...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+\.(?:js|css))"/g)
  ].map((match) => match[1]);

  const cssAssets = linkedAssets.filter((asset) => asset.endsWith('.css'));
  const jsAssets = linkedAssets.filter((asset) => asset.endsWith('.js'));
  const cssGzip = sumGzip(distDir, cssAssets);
  const initialJsGzip = sumGzip(distDir, jsAssets);

  assert.ok(cssGzip <= 45 * 1024, `初始 CSS ${formatKb(cssGzip)} gzip，超过 45KB`);
  assert.ok(
    initialJsGzip <= 145 * 1024,
    `初始 JS/modulepreload ${formatKb(initialJsGzip)} gzip，超过 145KB`
  );

  const pageChunks = readdirSync(new URL('assets/', distDir)).filter((file) =>
    /^V2.+View-.+\.js$/.test(file)
  );
  for (const file of pageChunks) {
    const size = gzipSync(readFileSync(new URL(`assets/${file}`, distDir))).byteLength;
    assert.ok(size <= 25 * 1024, `${file} 为 ${formatKb(size)} gzip，超过 25KB`);
  }
  console.log(
    `[PASS] bundle budgets: CSS=${formatKb(cssGzip)}, initial JS=${formatKb(initialJsGzip)}, page chunks=${pageChunks.length}`
  );
}

async function checkBrowserRuntime() {
  const username = process.env.V2_PERF_USERNAME ?? process.env.SEED_ADMIN_USERNAME;
  const password = process.env.V2_PERF_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;
  assert.ok(username && password, '缺少 V2_PERF_USERNAME/V2_PERF_PASSWORD 或 seed 管理员账号');
  assert.ok(
    ALLOW_REMOTE_PREVIEW ||
      ['localhost', '127.0.0.1', '::1'].includes(new URL(ADMIN_BASE_URL).hostname),
    '远程预览验收必须显式设置 V2_PERF_ALLOW_REMOTE=true'
  );

  const health = await fetch(`${ADMIN_BASE_URL}/login`, {
    signal: AbortSignal.timeout(5_000)
  }).catch(() => null);
  assert.ok(health?.ok, `本地 V2 管理端不可用：${ADMIN_BASE_URL}`);

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await desktop.newPage();
    const errors = [];
    let allowExpected503 = false;
    let expectedChunkFailureView = '';
    page.on('pageerror', (error) => {
      if (
        expectedChunkFailureView &&
        ((error.message.includes('Failed to fetch dynamically imported module') &&
          error.message.includes(expectedChunkFailureView)) ||
          error.message.includes(`Couldn't resolve component "default"`))
      ) {
        return;
      }
      errors.push(`pageerror:${error.message}`);
    });
    page.on('console', (message) => {
      const location = message.location();
      const isExpectedChunkFailure =
        Boolean(expectedChunkFailureView) &&
        message.text().includes('net::ERR_FAILED') &&
        location.url.includes(expectedChunkFailureView);
      if (
        message.type() === 'error' &&
        !(allowExpected503 && message.text().includes('503 (Service Unavailable)')) &&
        !isExpectedChunkFailure
      ) {
        errors.push(
          `console:${message.text()}${location.url ? ` @ ${location.url}:${location.lineNumber}` : ''}`
        );
      }
    });

    await page.route('**/assets/*.js', async (route) => {
      await delay(RESOURCE_DELAY_MS);
      await route.continue();
    });
    await page.route('**/api/id-business-v2/**', async (route) => {
      await delay(API_DELAY_MS);
      await route.continue();
    });

    const committed = await page.goto(`${ADMIN_BASE_URL}/login`, { waitUntil: 'commit' });
    assert.ok(committed, '登录页导航没有响应');
    await page.locator('.v2-boot').waitFor({ state: 'visible', timeout: 2_000 });
    assert.equal(await page.locator('.v2-boot__sidebar, .v2-boot__nav').count(), 0);
    await page.waitForLoadState('domcontentloaded');
    await page
      .locator('#v2-admin-login-form')
      .waitFor({ state: 'visible', timeout: HTTP_TIMEOUT_MS });
    const loginMarks = await page.evaluate(() =>
      performance.getEntriesByType('mark').map((entry) => entry.name)
    );
    assert.ok(loginMarks.includes('v2:app-mounted'), '登录表单出现前没有记录 Vue mount');
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(password);
    await page.locator('#v2-admin-login-form button[type="submit"]').click();
    await page.waitForURL('**/v2/**', { timeout: HTTP_TIMEOUT_MS });
    await waitForPageReady(page);
    const authenticatedState = await captureAuthenticatedBrowserState(desktop, page);
    await verifyDelayedAuthMount(browser, authenticatedState);
    await verifyInitialChunkRecovery(browser, authenticatedState);
    await verifyRepeatedInitialChunkFailure(browser, authenticatedState);

    await verifyIntentPrefetch(page, '/v2/customers', 'V2CustomersView');
    await verifySpeculativeChunkFailureInFreshContext(
      browser,
      authenticatedState,
      '/v2/accounts',
      'V2AccountsView'
    );
    expectedChunkFailureView = 'V2ActivationsView';
    try {
      await verifyRouteChunkRecovery(page, '/v2/records/activations', 'V2ActivationsView');
    } finally {
      expectedChunkFailureView = '';
    }

    const orderRequests = [];
    const optionRequests = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (
        request.method() === 'GET' &&
        (url.pathname.endsWith('/api/id-business-v2/orders') ||
          url.pathname.endsWith('/api/id-business-v2/orders/bootstrap'))
      ) {
        orderRequests.push(url.href);
      }
      if (
        request.method() === 'GET' &&
        (url.pathname.endsWith('/api/id-business-v2/options') ||
          url.pathname.endsWith('/api/id-business-v2/options/bootstrap'))
      ) {
        optionRequests.push(url.pathname);
      }
    });

    const firstNavigation = await navigateAndMeasure(page, '/v2/orders');
    assert.ok(firstNavigation.feedbackMs <= 100, `点击反馈耗时 ${firstNavigation.feedbackMs}ms`);
    assert.equal(firstNavigation.blankFrames, 0, '订单首次切换出现空白帧');
    assert.ok(firstNavigation.maxVisibleRoots <= 1, '订单切换期间旧、新页面同时可见');
    await page
      .locator('input[placeholder="订单号、客户、平台订单号、ID 账号、网站账号"]')
      .fill('保留条件');
    const requestsAfterFirstVisit = orderRequests.length;

    await navigateAndMeasure(page, '/v2/customers');
    await page.evaluate(() => {
      const originalNow = Date.now.bind(Date);
      Object.defineProperty(window, '__v2AcceptanceRestoreDateNow', {
        configurable: true,
        value: () => {
          Date.now = originalNow;
          delete window.__v2AcceptanceRestoreDateNow;
        }
      });
      Date.now = () => originalNow() + 6 * 60 * 1000;
    });
    await navigateAndMeasure(page, '/v2/orders');
    assert.equal(
      orderRequests.length,
      requestsAfterFirstVisit,
      '超过旧 TTL 后回访 clean 订单页仍重复请求'
    );
    await page.evaluate(() => window.__v2AcceptanceRestoreDateNow?.());
    assert.equal(
      await page
        .locator('input[placeholder="订单号、客户、平台订单号、ID 账号、网站账号"]')
        .inputValue(),
      '',
      '普通列表页仍依赖 KeepAlive 保留临时筛选'
    );
    assert.equal(
      await page.locator('.v2-page-state--loading').count(),
      0,
      '已访问页面回访仍显示整页骨架'
    );

    allowExpected503 = true;
    const refreshFailureDelayMs = Math.max(API_DELAY_MS, 240);
    await page.route('**/api/id-business-v2/orders?**', async (route) => {
      await delay(refreshFailureDelayMs);
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'performance acceptance failure' })
      });
    });
    await page
      .getByRole('region', { name: '订单筛选' })
      .getByLabel('刷新', { exact: true })
      .click();
    await page.locator('#v2-main .v2-async-region__progress').waitFor({ state: 'visible' });
    assert.equal(
      await page.locator('#v2-main .v2-async-region__progress').count(),
      1,
      '同一次订单刷新显示了多个主加载反馈'
    );
    assert.equal(
      await page.locator('.v2-records-toolbar__actions .el-button.is-loading').count(),
      0,
      '订单读取刷新同时显示了按钮 loading'
    );
    assert.equal(
      await page.locator('.v2-query-activity').count(),
      0,
      '订单读取刷新同时显示了全局更新文案'
    );
    await page
      .locator('#v2-main .v2-async-region__refresh-error')
      .waitFor({ state: 'visible', timeout: HTTP_TIMEOUT_MS });
    assert.equal(
      await page.locator('.v2-page-state--error').count(),
      0,
      '后台刷新失败清空了已有页面'
    );
    assert.equal(
      await page.locator('#v2-main .v2-async-region__progress').count(),
      0,
      '读取结束后区域进度线没有消失'
    );
    assert.equal(
      await page.locator('#v2-main .v2-async-region__refresh-error').count(),
      1,
      '已有内容刷新失败没有显示唯一的区域内错误'
    );
    await page.unroute('**/api/id-business-v2/orders?**');
    await page.waitForTimeout(250);
    allowExpected503 = false;

    await navigateAndMeasure(page, '/v2/workbench/order-entry');
    const draftInput = page
      .locator('.el-form-item')
      .filter({ hasText: '客户业务账号' })
      .locator('input')
      .first();
    await draftInput.fill('draft-kept-in-memory');
    await navigateAndMeasure(page, '/v2/customers');
    await navigateAndMeasure(page, '/v2/workbench/order-entry');
    assert.equal(await draftInput.inputValue(), 'draft-kept-in-memory', '订单未提交草稿切页后丢失');

    await navigateAndMeasure(page, '/v2/options');
    assert.equal(
      optionRequests.filter((path) => path.endsWith('/options/bootstrap')).length,
      1,
      '选项设置首次进入没有只请求一次 bootstrap'
    );
    const optionListRequestsBeforeSwitch = optionRequests.filter((path) =>
      path.endsWith('/options')
    ).length;
    await verifyFreshOptionTypeSwitch(page, '国家', ['默认货币']);
    await verifyFreshOptionTypeSwitch(page, '开通业务', ['上级国家', '业务金额']);
    await verifyFreshOptionTypeSwitch(page, '结算平台', ['固定手续费', '百分比手续费']);
    await verifyFreshOptionTypeSwitch(page, 'ID状态', []);
    const optionListRequestsAfterSwitch = optionRequests.filter((path) =>
      path.endsWith('/options')
    ).length;
    assert.equal(
      optionListRequestsAfterSwitch,
      optionListRequestsBeforeSwitch + 4,
      '选项类型切换没有逐类强制拉取最新数据'
    );

    const refreshResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === 'GET' &&
        url.pathname.endsWith('/api/id-business-v2/options')
      );
    });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await refreshResponse;
    assert.equal(
      optionRequests.filter((path) => path.endsWith('/options')).length,
      optionListRequestsAfterSwitch + 1,
      '手动刷新没有只请求当前选项类型一次'
    );

    const optionListRequestsBeforeRapidSwitch = optionRequests.filter((path) =>
      path.endsWith('/options')
    ).length;
    await page.getByText('国家', { exact: true }).first().click();
    await page.getByText('开通业务', { exact: true }).first().click();
    await page.getByText('ID状态', { exact: true }).first().click();
    await page.waitForFunction(
      () =>
        document.querySelector('.v2-options-category-nav .is-active')?.textContent?.trim() ===
          'ID状态' &&
        document.querySelector('.v2-options-list [aria-busy]')?.getAttribute('aria-busy') !== 'true'
    );
    assert.equal(
      await page.getByRole('columnheader', { name: '默认货币', exact: true }).count(),
      0,
      '快速连续切换后仍残留国家列'
    );
    assert.equal(
      await page.getByRole('columnheader', { name: '业务金额', exact: true }).count(),
      0,
      '快速连续切换后仍残留开通业务列'
    );
    const rapidSwitchRequestCount =
      optionRequests.filter((path) => path.endsWith('/options')).length -
      optionListRequestsBeforeRapidSwitch;
    assert.ok(
      rapidSwitchRequestCount >= 1 && rapidSwitchRequestCount <= 3,
      `快速连续切换请求数异常：${rapidSwitchRequestCount}`
    );

    const firstVisitSkeletons = new Map([
      ['/v2/workbench/renewals', 'table'],
      ['/v2/workbench/topups', 'table'],
      ['/v2/records/topups', 'table'],
      ['/v2/exchange-rates', 'metrics']
    ]);
    for (const path of ALL_V2_PATHS) {
      const result = await navigateAndMeasure(page, path);
      assert.ok(result.feedbackMs <= 100, `${path} 点击反馈耗时 ${result.feedbackMs}ms`);
      assert.ok(result.readyMs <= 1_800, `${path} 首屏就绪耗时 ${result.readyMs}ms`);
      assert.equal(result.blankFrames, 0, `${path} 切换出现空白帧`);
      assert.ok(result.maxVisibleRoots <= 1, `${path} 切换期间旧、新页面同时可见`);
      const expectedSkeleton = firstVisitSkeletons.get(path);
      if (expectedSkeleton) {
        assert.ok(
          result.skeletonKinds.includes(expectedSkeleton),
          `${path} 首次加载没有显示 ${expectedSkeleton} 内容形状骨架`
        );
      }
      assert.equal(
        await page.locator('.v2-page-state--loading').count(),
        0,
        `${path} 页面仍停留在加载状态`
      );
      assert.equal(
        await page.locator('.v2-page-state--error, .v2-route-error').count(),
        0,
        `${path} 页面出现错误状态`
      );
    }

    await verifyRuntimeErrorFreeNavigationSequence(page, errors);

    assert.deepEqual(errors, [], `浏览器运行错误：${errors.join('; ')}`);

    const mobileAuthenticatedState = await captureAuthenticatedBrowserState(desktop, page);
    await desktop.close();
    await verifyMobile(browser, mobileAuthenticatedState);
  } finally {
    await browser.close();
  }
}

async function verifyDelayedAuthMount(browser, authenticatedState) {
  const context = await createAuthenticatedContext(browser, authenticatedState, {
    viewport: { width: 1440, height: 900 }
  });
  await context.addInitScript(() => {
    Object.defineProperty(window, 'BroadcastChannel', {
      configurable: true,
      value: undefined
    });
  });
  const page = await context.newPage();
  let releaseAuthRequest = () => undefined;
  const authRequestRelease = new Promise((resolve) => {
    releaseAuthRequest = resolve;
  });
  const authRequestObserved = page.waitForRequest(
    (request) => new URL(request.url()).pathname.endsWith('/api/auth/me'),
    { timeout: HTTP_TIMEOUT_MS }
  );
  await page.route('**/api/auth/me', async (route) => {
    await authRequestRelease;
    await route.continue();
  });

  try {
    const navigation = page.goto(`${ADMIN_BASE_URL}/v2/workbench/renewals`, {
      waitUntil: 'domcontentloaded'
    });
    await page.waitForFunction(
      () => performance.getEntriesByName('v2:app-mounted').length === 1,
      undefined,
      { timeout: HTTP_TIMEOUT_MS }
    );
    await authRequestObserved;

    const duringAuth = await page.evaluate(() => ({
      authReady: performance.getEntriesByName('v2:auth-check-end').length > 0,
      businessShell: document.querySelectorAll('.v2-shell').length,
      bootGate: document.querySelectorAll('.v2-boot-gate').length,
      mountedAt: performance.getEntriesByName('v2:app-mounted')[0]?.startTime ?? null
    }));
    assert.equal(duringAuth.authReady, false, '鉴权延迟期间错误标记为 auth ready');
    assert.equal(duringAuth.businessShell, 0, '鉴权未确认时提前渲染业务工作区');
    assert.equal(duringAuth.bootGate, 1, '鉴权延迟期间缺少稳定 Boot Gate');

    releaseAuthRequest();
    await navigation;
    await waitForPageReady(page);
    const timing = await page.evaluate(() => ({
      authReadyAt: performance.getEntriesByName('v2:auth-check-end')[0]?.startTime ?? null,
      mountedAt: performance.getEntriesByName('v2:app-mounted')[0]?.startTime ?? null,
      routeCodeReadyAt:
        performance.getEntriesByName('v2:route-code-ready').at(-1)?.startTime ?? null,
      routeDataReadyAt:
        performance.getEntriesByName('v2:route-data-ready').at(-1)?.startTime ?? null,
      ambiguousRouteReadyMarks: performance.getEntriesByName('v2:route-ready').length
    }));
    assert.ok(
      timing.mountedAt !== null &&
        timing.authReadyAt !== null &&
        timing.mountedAt < timing.authReadyAt,
      'Vue 应用没有在鉴权完成前挂载'
    );
    assert.ok(
      timing.routeCodeReadyAt !== null &&
        timing.authReadyAt !== null &&
        timing.authReadyAt <= timing.routeCodeReadyAt,
      '受保护路由在鉴权完成前标记为代码就绪'
    );
    assert.ok(
      timing.routeDataReadyAt !== null &&
        timing.routeCodeReadyAt !== null &&
        timing.routeCodeReadyAt <= timing.routeDataReadyAt,
      '业务数据在路由代码完成前被标记为就绪'
    );
    assert.equal(timing.ambiguousRouteReadyMarks, 0, '仍在记录语义含糊的 route-ready 指标');
  } finally {
    releaseAuthRequest();
    await context.close();
  }
}

async function verifyInitialChunkRecovery(browser, authenticatedState) {
  const context = await createAuthenticatedContext(browser, authenticatedState, {
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();
  const targetPath = '/v2/records/topups';
  const routePattern = routeChunkPattern('V2TopupRecordsView');
  let chunkAttempts = 0;
  let documentNavigations = 0;
  const runtimeErrors = [];

  page.on('pageerror', (error) => runtimeErrors.push(`pageerror:${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('net::ERR_FAILED')) {
      runtimeErrors.push(`console:${message.text()}`);
    }
  });

  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      documentNavigations += 1;
    }
  });
  await page.route('**/api/id-business-v2/**', async (route) => {
    await delay(API_DELAY_MS);
    await route.continue();
  });
  await page.route(routePattern, async (route) => {
    chunkAttempts += 1;
    if (chunkAttempts === 1) {
      await route.abort('failed');
      return;
    }
    await route.fallback();
  });

  try {
    await page
      .goto(`${ADMIN_BASE_URL}${targetPath}`, { waitUntil: 'domcontentloaded' })
      .catch(() => null);
    await page.waitForURL((url) => url.pathname === targetPath, { timeout: HTTP_TIMEOUT_MS });
    try {
      await waitForPageReady(page);
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        body: document.body.innerText.slice(0, 2_000),
        credentialPresent: Boolean(sessionStorage.getItem('apple_business_auth_v2')),
        path: location.pathname,
        reloadBuild: sessionStorage.getItem('apple-business:v2-preload-reload-build'),
        routeErrors: performance
          .getEntriesByName('v2:route-data-error')
          .map((entry) => entry.detail ?? null)
      }));
      throw new Error(
        `首次 Chunk 恢复未就绪：${JSON.stringify({ chunkAttempts, documentNavigations, diagnostics, runtimeErrors })}`,
        { cause: error }
      );
    }

    const recovery = await page.evaluate(() => ({
      buildId: document.querySelector('meta[name="v2-build-id"]')?.getAttribute('content') ?? null,
      rememberedBuildId: sessionStorage.getItem('apple-business:v2-preload-reload-build')
    }));
    assert.ok(chunkAttempts >= 2, '首个路由 Chunk 失败后没有自动重试');
    assert.equal(documentNavigations, 2, '首个路由 Chunk 失败没有且仅有一次自动刷新');
    assert.ok(recovery.buildId, '生产 HTML 缺少 Chunk 恢复 buildId');
    assert.equal(recovery.rememberedBuildId, recovery.buildId, '自动刷新没有按当前构建版本记忆');
  } finally {
    await context.close();
  }
}

async function verifyRepeatedInitialChunkFailure(browser, authenticatedState) {
  const context = await createAuthenticatedContext(browser, authenticatedState, {
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();
  const targetPath = '/v2/workbench/topups';
  const routePattern = routeChunkPattern('V2TopupWorkbenchView');
  let chunkAttempts = 0;
  let documentNavigations = 0;

  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      documentNavigations += 1;
    }
  });
  await page.route(routePattern, async (route) => {
    chunkAttempts += 1;
    await route.abort('failed');
  });

  try {
    await page
      .goto(`${ADMIN_BASE_URL}${targetPath}`, { waitUntil: 'domcontentloaded' })
      .catch(() => null);
    await page
      .getByText('页面资源加载失败', { exact: true })
      .waitFor({ state: 'visible', timeout: HTTP_TIMEOUT_MS });
    const attemptsAtDegraded = chunkAttempts;
    await page.waitForTimeout(Math.max(250, RESOURCE_DELAY_MS));

    assert.equal(documentNavigations, 2, '同一构建的重复 Chunk 失败发生了无限刷新');
    assert.equal(chunkAttempts, attemptsAtDegraded, '进入可恢复错误后仍在自动重试 Chunk');
    assert.equal(
      await page.getByRole('button', { name: '重新连接', exact: true }).count(),
      1,
      '重复启动失败没有提供唯一的人工恢复入口'
    );
  } finally {
    await context.close();
  }
}

async function verifyIntentPrefetch(page, targetPath, targetViewName) {
  const previousPath = new URL(page.url()).pathname;
  const routePattern = routeChunkPattern(targetViewName);
  const link = await ensureNavigationLinkVisible(page, targetPath);
  let chunkRequests = 0;
  let dataRequests = 0;
  const handleRequest = (request) => {
    const url = new URL(request.url());
    if (routePattern.test(url.href)) chunkRequests += 1;
    if (
      request.method() === 'GET' &&
      (url.pathname.endsWith('/api/id-business-v2/customers') ||
        url.pathname.endsWith('/api/id-business-v2/customers/bootstrap'))
    ) {
      dataRequests += 1;
    }
  };
  page.on('request', handleRequest);

  try {
    await link.dispatchEvent('pointerenter', { pointerType: 'mouse' });
    await page.waitForTimeout(20);
    await link.dispatchEvent('pointerleave', { pointerType: 'mouse' });
    await page.waitForTimeout(100);
    assert.equal(chunkRequests, 0, '短暂掠过导航仍触发了无意图 Chunk 预取');

    const prefetched = page.waitForResponse(
      (response) => routePattern.test(response.url()) && response.ok(),
      { timeout: HTTP_TIMEOUT_MS }
    );
    await link.focus();
    await prefetched;
    assert.equal(new URL(page.url()).pathname, previousPath, '聚焦预取错误改变了当前路由');
    assert.equal(dataRequests, 0, '路由意图预取提前请求了敏感业务数据');
    assert.equal(await page.locator('.v2-route-error').count(), 0, '成功预取错误显示路由失败');
    assert.equal(
      await page.locator('.v2-route-progress.is-active').count(),
      0,
      '意图预取错误显示成真实导航进度'
    );
    await page.waitForFunction(
      (path) =>
        [...performance.getEntriesByName('v2:route-prefetch-ready')].some(
          (entry) => entry.detail?.path === path && entry.detail?.intent === 'focus'
        ),
      targetPath,
      { timeout: HTTP_TIMEOUT_MS }
    );
    const prefetchMark = await page.evaluate((path) => {
      const marks = performance.getEntriesByName('v2:route-prefetch-ready');
      const mark = [...marks].reverse().find((entry) => entry.detail?.path === path);
      return mark?.detail ?? null;
    }, targetPath);
    assert.deepEqual(
      prefetchMark,
      { path: targetPath, intent: 'focus' },
      '意图预取缺少可观测的路径和触发来源'
    );

    const navigation = await navigateAndMeasure(page, targetPath);
    assert.ok(navigation.codeReadyMs <= 100, `预取后路由代码仍耗时 ${navigation.codeReadyMs}ms`);
    assert.equal(navigation.dataSource, 'network', '首次页面数据没有区分为真实网络就绪');
    assert.ok(dataRequests >= 1, '点击目标页面后没有请求真实业务数据');
  } finally {
    page.off('request', handleRequest);
  }
}

async function verifySpeculativeChunkFailureInFreshContext(
  browser,
  authenticatedState,
  targetPath,
  targetViewName
) {
  const context = await createAuthenticatedContext(browser, authenticatedState, {
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();
  await page.route('**/api/id-business-v2/**', async (route) => {
    await delay(API_DELAY_MS);
    await route.continue();
  });

  try {
    await page.goto(`${ADMIN_BASE_URL}/v2/dashboard`, { waitUntil: 'domcontentloaded' });
    await waitForPageReady(page);
    await verifySpeculativeChunkFailure(page, targetPath, targetViewName);
  } finally {
    await context.close();
  }
}

async function verifySpeculativeChunkFailure(page, targetPath, targetViewName) {
  const previousPath = new URL(page.url()).pathname;
  const routePattern = routeChunkPattern(targetViewName);
  let chunkAttempts = 0;

  await page.route(routePattern, async (route) => {
    chunkAttempts += 1;
    if (chunkAttempts === 1) {
      await route.abort('failed');
      return;
    }
    await route.fallback();
  });

  try {
    const link = await ensureNavigationLinkVisible(page, targetPath);
    const firstAttempt = page.waitForRequest((request) => routePattern.test(request.url()), {
      timeout: HTTP_TIMEOUT_MS
    });
    await link.focus();
    await firstAttempt;
    await page.waitForTimeout(120);

    assert.equal(new URL(page.url()).pathname, previousPath, '预取失败改变了当前路由');
    assert.equal(await page.locator('.v2-route-error').count(), 0, '预取失败误报为当前页面错误');
    assert.equal(await page.locator('.app-route-error').count(), 0, '预取失败触发全屏运行时错误');
    assert.equal(
      await page.locator('.v2-route-progress.is-active').count(),
      0,
      '预取失败残留真实导航进度'
    );

    await link.evaluate((element) => element.click());
    await page.locator('.v2-route-error').waitFor({ state: 'visible', timeout: HTTP_TIMEOUT_MS });
    assert.equal(
      new URL(page.url()).pathname,
      previousPath,
      '用户打开预取失败页面时没有继续保留稳定页面'
    );
    await recoverFailedRoute(page, targetPath);
    assert.ok(chunkAttempts >= 2, '人工恢复没有在新文档中重新请求预取失败的 Chunk');
  } finally {
    await page.unroute(routePattern);
  }
}

async function verifyRouteChunkRecovery(page, targetPath, targetViewName) {
  const previousPath = new URL(page.url()).pathname;
  let chunkAttempts = 0;
  const routePattern = routeChunkPattern(targetViewName);

  await page.route(routePattern, async (route) => {
    chunkAttempts += 1;
    if (chunkAttempts === 1) {
      await route.abort('failed');
      return;
    }
    await route.fallback();
  });

  try {
    const link = page.locator(`a[href="${targetPath}"]`).first();
    await link.waitFor({ state: 'attached', timeout: HTTP_TIMEOUT_MS });
    await link.evaluate((element) => element.click());
    await page.locator('.v2-route-error').waitFor({ state: 'visible', timeout: HTTP_TIMEOUT_MS });

    assert.equal(new URL(page.url()).pathname, previousPath, 'Chunk 失败后当前页面没有保留');
    assert.equal(await page.locator('.v2-shell').count(), 1, 'Chunk 失败后工作区外壳丢失');
    assert.equal(await page.locator('.v2-route-error').count(), 1, 'Chunk 失败显示了重复错误');
    assert.equal(await page.locator('.app-route-error').count(), 0, 'Chunk 失败错误触发全屏遮罩');
    await recoverFailedRoute(page, targetPath);
    assert.ok(chunkAttempts >= 2, '手动重试没有重新请求失败的路由 Chunk');
  } finally {
    await page.unroute(routePattern);
  }
}

async function recoverFailedRoute(page, targetPath) {
  const retrySentinel = `retry-${Date.now()}`;
  await page.evaluate((value) => {
    window.__V2_CHUNK_RETRY_SENTINEL__ = value;
  }, retrySentinel);
  await page
    .locator('.v2-route-error')
    .getByRole('button', { name: '重新加载', exact: true })
    .click();
  await page.waitForURL((url) => url.pathname === targetPath, { timeout: HTTP_TIMEOUT_MS });
  await waitForPageReady(page);
  assert.equal(
    await page.evaluate(() => window.__V2_CHUNK_RETRY_SENTINEL__),
    undefined,
    '人工 Chunk 恢复没有建立新的模块加载上下文'
  );
}

function routeChunkPattern(viewName) {
  return new RegExp(`${viewName}[^/]*(?:\\.vue|\\.js)(?:\\?.*)?$`);
}

async function ensureNavigationLinkVisible(page, path) {
  const link = page.locator(`a[href="${path}"]`).first();
  await link.waitFor({ state: 'attached', timeout: HTTP_TIMEOUT_MS });
  if (!(await link.isVisible())) {
    const navigationSection = link.locator('xpath=ancestor::section[1]');
    await navigationSection.locator('.v2-navigation__parent').click();
    await link.waitFor({ state: 'visible', timeout: HTTP_TIMEOUT_MS });
  }
  return link;
}

async function verifyRuntimeErrorFreeNavigationSequence(page, runtimeErrors) {
  const paths = [
    '/v2/monitoring/business',
    '/v2/monitoring/system',
    '/v2/dashboard',
    '/v2/monitoring/business'
  ];

  for (const path of paths) {
    const link = await ensureNavigationLinkVisible(page, path);
    await link.click();
    await page.waitForURL((url) => url.pathname === path, { timeout: HTTP_TIMEOUT_MS });
    try {
      await waitForPageReady(page);
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        loadingStates: [...document.querySelectorAll('#v2-main .v2-page-state--loading')].map(
          (element) => element.textContent?.trim()
        ),
        path: location.pathname,
        routeDataErrors: performance
          .getEntriesByName('v2:route-data-error')
          .map((entry) => entry.detail ?? null),
        routeDataReady: performance
          .getEntriesByName('v2:route-data-ready')
          .map((entry) => entry.detail ?? null),
        visibleErrors: [...document.querySelectorAll('#v2-main [role="alert"]')].map((element) =>
          element.textContent?.trim()
        )
      }));
      throw new Error(
        `${path} 页面未就绪：${JSON.stringify({ diagnostics, runtimeErrors: runtimeErrors.slice(-3) })}`,
        { cause: error }
      );
    }
    assert.equal(
      await page.locator('.app-route-error').count(),
      0,
      `${path} 可恢复导航错误触发全局运行时弹窗：${runtimeErrors.slice(-3).join('; ')}`
    );
  }
}

async function verifyFreshOptionTypeSwitch(page, label, expectedColumns) {
  const monitor = page.evaluate(async (targetLabel) => {
    const startedAt = Date.now();
    let feedbackMs = Number.POSITIVE_INFINITY;
    let blankFrames = 0;
    while (Date.now() - startedAt < 1_000) {
      const activeLabel = document
        .querySelector('.v2-options-category-nav .is-active')
        ?.textContent?.trim();
      const list = document.querySelector('.v2-options-list');
      const hasStructure = Boolean(
        list?.querySelector('.v2-records-table, .v2-records-empty, .v2-async-region')
      );
      if (activeLabel === targetLabel && feedbackMs === Number.POSITIVE_INFINITY) {
        feedbackMs = Date.now() - startedAt;
      }
      if (!hasStructure) blankFrames += 1;
      if (
        activeLabel === targetLabel &&
        document.querySelector('.v2-options-list [aria-busy]')?.getAttribute('aria-busy') !== 'true'
      ) {
        return {
          feedbackMs,
          settledMs: Date.now() - startedAt,
          blankFrames
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return {
      feedbackMs,
      settledMs: Date.now() - startedAt,
      blankFrames
    };
  }, label);
  await page.getByText(label, { exact: true }).first().click();
  const result = await monitor;
  assert.ok(result.feedbackMs <= 100, `${label} 选项反馈耗时 ${result.feedbackMs}ms`);
  assert.ok(
    result.settledMs <= API_DELAY_MS + 250,
    `${label} 最新数据刷新耗时 ${result.settledMs}ms`
  );
  assert.equal(result.blankFrames, 0, `${label} 切换出现空白列表`);
  assert.equal(
    await page.locator('.v2-options-page .v2-async-region__progress').count(),
    0,
    `${label} 最新数据刷新结束后仍残留进度线`
  );
  for (const column of expectedColumns) {
    assert.equal(
      await page.getByRole('columnheader', { name: column, exact: true }).count(),
      1,
      `${label} 切换后缺少${column}列`
    );
  }
}

async function verifyMobile(browser, authenticatedState) {
  const context = await createAuthenticatedContext(browser, authenticatedState, {
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce'
  });
  const page = await context.newPage();
  await page.route('**/api/id-business-v2/**', async (route) => {
    await delay(API_DELAY_MS);
    await route.continue();
  });
  await page.goto(`${ADMIN_BASE_URL}/v2/workbench/renewals`, { waitUntil: 'domcontentloaded' });
  await waitForPageReady(page);
  await page.getByTitle('打开导航').click();
  await page.locator('.v2-sidebar.is-mobile-open').waitFor({ state: 'visible' });
  const result = await navigateAndMeasure(page, '/v2/orders');
  assert.equal(result.blankFrames, 0, '移动端切换出现空白帧');
  assert.ok(result.maxVisibleRoots <= 1, '移动端切换期间旧、新页面同时可见');
  assert.equal(await page.locator('.v2-sidebar.is-mobile-open').count(), 0, '移动端导航未立即关闭');
  assert.equal(await page.locator('[aria-busy="true"] .v2-route-skeleton').count(), 0);
  await context.close();
}

async function captureAuthenticatedBrowserState(context, page) {
  const sessionEntries = await page.evaluate(() =>
    Object.fromEntries(
      Object.entries(sessionStorage).filter(
        ([key]) => key === 'apple_business_auth_v2' || /^sb-.+-auth-token(?:-.+)?$/.test(key)
      )
    )
  );
  assert.ok(sessionEntries.apple_business_auth_v2, '测试浏览器缺少 V2 会话凭据');
  return {
    sessionEntries,
    storageState: await context.storageState()
  };
}

async function createAuthenticatedContext(browser, authenticatedState, options) {
  const context = await browser.newContext({
    ...options,
    storageState: authenticatedState.storageState
  });
  await context.addInitScript(
    ({ origin, sessionEntries }) => {
      if (location.origin === origin) {
        for (const [key, value] of Object.entries(sessionEntries)) {
          sessionStorage.setItem(key, value);
        }
      }
    },
    {
      origin: new URL(ADMIN_BASE_URL).origin,
      sessionEntries: authenticatedState.sessionEntries
    }
  );
  return context;
}

async function navigateAndMeasure(page, path) {
  const link = await ensureNavigationLinkVisible(page, path);
  const previousNavigationId = await page.evaluate(() => {
    const latest = performance.getEntriesByName('v2:route-start').at(-1);
    return Number(latest?.detail?.navigationId ?? 0);
  });
  const startedAt = Date.now();
  await link.click({ noWaitAfter: true });

  let feedbackMs = Number.POSITIVE_INFINITY;
  let blankFrames = 0;
  let maxVisibleRoots = 0;
  let settledSnapshot = null;
  const skeletonKinds = new Set();
  while (Date.now() - startedAt < HTTP_TIMEOUT_MS) {
    let snapshot;
    try {
      snapshot = await page.evaluate(
        ({ targetPath, minimumNavigationId }) => {
          const main = document.querySelector('#v2-main');
          const inner = main?.querySelector('.v2-content__inner');
          const progress = document.querySelector('.v2-route-progress.is-active');
          const title = document.querySelector('.v2-topbar__identity h1');
          const dataReadyMark = [...performance.getEntriesByName('v2:route-data-ready')]
            .reverse()
            .find(
              (entry) =>
                entry.detail?.path === targetPath &&
                Number(entry.detail?.navigationId ?? 0) > minimumNavigationId
            );
          const navigationId = dataReadyMark?.detail?.navigationId;
          const routeStartMark = [...performance.getEntriesByName('v2:route-start')]
            .reverse()
            .find((entry) => entry.detail?.navigationId === navigationId);
          const codeReadyMark = [...performance.getEntriesByName('v2:route-code-ready')]
            .reverse()
            .find((entry) => entry.detail?.navigationId === navigationId);
          const ready =
            location.pathname === targetPath &&
            Boolean(title?.textContent?.trim()) &&
            Boolean(dataReadyMark && routeStartMark && codeReadyMark) &&
            !document.querySelector('#v2-main .v2-page-state--loading');
          const hasStructure =
            Boolean(document.querySelector('.v2-boot')) ||
            Boolean(
              main?.querySelector(
                '.v2-async-region, .v2-route-skeleton, .v2-page-state, .v2-table-shell, .v2-records-list, .v2-form-shell'
              )
            );
          const visibleRoots = inner
            ? [...inner.children].filter((element) => {
                if (element.classList.contains('v2-route-error')) return false;
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return (
                  style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  Number(style.opacity || 1) > 0 &&
                  rect.width > 0 &&
                  rect.height > 0
                );
              }).length
            : 0;
          const visibleSkeletonKinds = [...document.querySelectorAll('[data-v2-skeleton]')]
            .filter((element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' && rect.height > 0;
            })
            .map((element) => element.getAttribute('data-v2-skeleton'))
            .filter(Boolean);
          return {
            progress: Boolean(progress),
            routeCommitted: location.pathname === targetPath,
            ready,
            hasStructure,
            visibleRoots,
            visibleSkeletonKinds,
            codeReadyMs:
              codeReadyMark && routeStartMark
                ? codeReadyMark.startTime - routeStartMark.startTime
                : null,
            dataReadyMs:
              dataReadyMark && routeStartMark
                ? dataReadyMark.startTime - routeStartMark.startTime
                : null,
            codeToDataMs:
              dataReadyMark && codeReadyMark
                ? dataReadyMark.startTime - codeReadyMark.startTime
                : null,
            dataSource: dataReadyMark?.detail?.source ?? null
          };
        },
        { targetPath: path, minimumNavigationId: previousNavigationId }
      );
    } catch (error) {
      if (!String(error).includes('Execution context was destroyed')) throw error;
      await page.waitForTimeout(20);
      continue;
    }
    settledSnapshot = snapshot;
    if (
      feedbackMs === Number.POSITIVE_INFINITY &&
      (snapshot.progress || snapshot.routeCommitted || snapshot.ready)
    ) {
      feedbackMs = Date.now() - startedAt;
    }
    if (!snapshot.hasStructure) blankFrames += 1;
    for (const kind of snapshot.visibleSkeletonKinds) skeletonKinds.add(kind);
    maxVisibleRoots = Math.max(maxVisibleRoots, snapshot.visibleRoots);
    if (snapshot.ready) break;
    await page.waitForTimeout(20);
  }
  await page.waitForURL((url) => url.pathname === path, { timeout: HTTP_TIMEOUT_MS });
  try {
    await waitForPageReady(page);
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      currentPath: location.pathname,
      dataReadyPaths: performance
        .getEntriesByName('v2:route-data-ready')
        .map((entry) => entry.detail?.path ?? null),
      dataErrors: performance
        .getEntriesByName('v2:route-data-error')
        .map((entry) => entry.detail ?? null),
      loadingRegions: document.querySelectorAll('#v2-main .v2-page-state--loading').length,
      routeError: document.querySelector('.v2-route-error')?.textContent?.trim() ?? ''
    }));
    throw new Error(`${path} 页面就绪失败：${JSON.stringify(diagnostics)}`, { cause: error });
  }
  const result = {
    path,
    feedbackMs,
    readyMs: Date.now() - startedAt,
    blankFrames,
    maxVisibleRoots,
    skeletonKinds: [...skeletonKinds],
    codeReadyMs: settledSnapshot?.codeReadyMs ?? null,
    dataReadyMs: settledSnapshot?.dataReadyMs ?? null,
    codeToDataMs: settledSnapshot?.codeToDataMs ?? null,
    dataSource: settledSnapshot?.dataSource ?? null
  };
  assert.ok(result.codeReadyMs !== null, `${path} 缺少路由代码就绪指标`);
  assert.ok(result.dataReadyMs !== null, `${path} 缺少业务数据就绪指标`);
  assert.ok(result.codeToDataMs !== null, `${path} 缺少代码到数据耗时指标`);
  assert.ok(result.dataReadyMs >= result.codeReadyMs, `${path} 数据就绪时间早于路由代码就绪时间`);
  navigationMetrics.push(result);
  if (REPORT_METRICS) console.log(`[V2 navigation metric] ${JSON.stringify(result)}`);
  return result;
}

async function waitForPageReady(page) {
  await page.locator('#v2-main').waitFor({ state: 'visible', timeout: HTTP_TIMEOUT_MS });
  await page
    .locator('.v2-topbar__identity h1')
    .waitFor({ state: 'visible', timeout: HTTP_TIMEOUT_MS });
  await page.waitForFunction(
    () => document.querySelectorAll('#v2-main .v2-page-state--loading').length === 0,
    undefined,
    { timeout: HTTP_TIMEOUT_MS }
  );
  await page.waitForFunction(
    () => {
      const currentPath = location.pathname;
      return [...performance.getEntriesByName('v2:route-data-ready')].some(
        (entry) => entry.detail?.path === currentPath
      );
    },
    undefined,
    { timeout: HTTP_TIMEOUT_MS }
  );
}

function sumGzip(distDir, assets) {
  return [...new Set(assets)].reduce((total, asset) => {
    const normalized = asset.replace(/^\//, '');
    return total + gzipSync(readFileSync(new URL(normalized, distDir))).byteLength;
  }, 0);
}

function read(relativePath) {
  return readFileSync(new URL(relativePath, rootDir), 'utf8');
}

function collectVueSources(relativePath) {
  const normalizedPath = relativePath.replace(/\/$/, '');
  const directory = new URL(`${normalizedPath}/`, rootDir);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const childPath = `${normalizedPath}/${entry.name}`;
    if (entry.isDirectory()) return collectVueSources(childPath);
    return entry.name.endsWith('.vue') ? [[childPath, read(childPath)]] : [];
  });
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(2)}KB`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
