#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const featuresPath = 'apps/admin/src/v2/features';
const asyncRegionPath = 'apps/admin/src/v2/components/V2AsyncRegion.vue';
const asyncRegionSource = read(asyncRegionPath);
const asyncRegionContextPath = 'apps/admin/src/v2/components/asyncRegionContext.ts';
const asyncRegionContextSource = read(asyncRegionContextPath);
const appButtonPath = 'apps/admin/src/components/ui/AppButton.vue';
const appButtonSource = read(appButtonPath);
const asyncRegionStatePath = 'apps/admin/src/v2/components/asyncRegionState.ts';
const asyncRegionStateSource = read(asyncRegionStatePath);
const contentSkeletonPath = 'apps/admin/src/v2/components/V2ContentSkeleton.vue';
const contentSkeletonSource = read(contentSkeletonPath);
const loadingVisualsPath = 'apps/admin/src/v2/components/loadingVisuals.ts';
const loadingVisualsSource = read(loadingVisualsPath);
const pageStatePath = 'apps/admin/src/v2/components/V2PageState.vue';
const pageStateSource = read(pageStatePath);
const layoutPath = 'apps/admin/src/v2/layouts/V2AdminLayout.vue';
const layoutSource = read(layoutPath);
const globalStylesPath = 'apps/admin/src/v2/styles/v2.css';
const globalStylesSource = read(globalStylesPath);
const queryCachePath = 'apps/admin/src/v2/composables/useV2Query.ts';
const queryCacheSource = read(queryCachePath);
const allowedFreshnessPolicies = new Set(['event-driven', 'event-with-deadline']);
const allowedSkeletonKinds = new Set([
  'table',
  'form',
  'metrics',
  'settings',
  'detail',
  'cards',
  'inline'
]);
const issues = [];

runSelfTests();
validateStartupArchitecture();

const featureManifests = readdirSync(path.join(rootDir, featuresPath), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `${featuresPath}/${entry.name}/manifest.ts`)
  .filter((projectPath) => existsSync(path.join(rootDir, projectPath)))
  .map((projectPath) => ({ projectPath, source: read(projectPath) }));
const routedViewEntries = featureManifests
  .map(({ projectPath, source }) => {
    const view = source.match(
      /loadView:\s*\(\)\s*=>\s*import\('\.\/(V2[A-Za-z0-9]+View\.vue)'\)/
    )?.[1];
    const key = source.match(/^\s{2}key: '([a-z0-9-]+)',\s*$/m)?.[1];
    const planned = /status:\s*'planned'/.test(source);
    return view
      ? {
          view,
          key,
          planned,
          projectPath: `${path.posix.dirname(projectPath)}/${view}`
        }
      : null;
  })
  .filter(Boolean);
const routedViews = routedViewEntries.map(({ view }) => view);
const uniqueRoutedViews = [...new Set(routedViews)];
const moduleKeys = featureManifests
  .map(({ source }) => source.match(/^\s{2}key: '([a-z0-9-]+)',\s*$/m)?.[1])
  .filter(Boolean);
const readyModuleKeys = featureManifests
  .filter(({ source }) => !/status:\s*'planned'/.test(source))
  .map(({ source }) => source.match(/^\s{2}key: '([a-z0-9-]+)',\s*$/m)?.[1])
  .filter(Boolean);

if (!uniqueRoutedViews.length) issues.push(`${featuresPath}: 没有发现 V2 路由业务页面`);
if (uniqueRoutedViews.length !== moduleKeys.length) {
  issues.push(
    `${featuresPath}: 路由页面数 ${uniqueRoutedViews.length} 与模块数 ${moduleKeys.length} 不一致`
  );
}

for (const { projectPath, source } of featureManifests) {
  const key = source.match(/^\s{2}key: '([a-z0-9-]+)',\s*$/m)?.[1] ?? projectPath;
  const freshnessPolicy = source.match(/freshnessPolicy: '([^']+)'/)?.[1];
  if (!freshnessPolicy || !allowedFreshnessPolicies.has(freshnessPolicy)) {
    issues.push(`${projectPath}: 模块 ${key} 缺少有效 freshnessPolicy`);
  }
}
const keepAliveModules = featureManifests
  .filter(({ source }) => /keepAlive:\s*true/.test(source))
  .map(({ source }) => source.match(/^\s{2}key: '([a-z0-9-]+)',\s*$/m)?.[1])
  .filter(Boolean);
if (keepAliveModules.length !== 1 || keepAliveModules[0] !== 'order-entry') {
  issues.push(
    `${featuresPath}: KeepAlive 只能用于订单录入草稿，当前为 ${keepAliveModules.join(', ') || '无'}`
  );
}

const registeredModuleKeys = new Set();
for (const { projectPath, planned } of routedViewEntries) {
  const viewSource = read(projectPath);
  const source = collectLocalSources(projectPath).join('\n');
  const viewIssues = validateViewSource(source, viewSource, !planned);
  for (const issue of viewIssues) issues.push(`${projectPath}: ${issue}`);

  if (planned) {
    if (/useV2ModuleQuery|<V2AsyncRegion\b/.test(source)) {
      issues.push(`${projectPath}: 规划占位页不得伪造远程查询或加载状态`);
    }
    continue;
  }

  const moduleKey = source.match(/moduleKey:\s*'([a-z0-9-]+)'/)?.[1];
  if (!moduleKey || !readyModuleKeys.includes(moduleKey)) {
    issues.push(`${projectPath}: 统一模块查询入口缺少有效 moduleKey`);
  } else if (registeredModuleKeys.has(moduleKey)) {
    issues.push(`${projectPath}: moduleKey ${moduleKey} 被重复注册`);
  } else {
    registeredModuleKeys.add(moduleKey);
  }
  if (!source.includes('useV2ModuleQuery')) {
    issues.push(`${projectPath}: LOAD-03 后所有页面必须使用 useV2ModuleQuery 承载真实数据`);
  }
}

for (const key of readyModuleKeys) {
  if (!registeredModuleKeys.has(key)) {
    issues.push(`${featuresPath}: 模块 ${key} 没有使用统一刷新入口的路由页面`);
  }
}

const loadingVisualSummary = validateLoadingVisualArchitecture();
forbidPatterns(layoutPath, layoutSource, [
  [/后台更新中/, '读取请求不得同时显示全局后台更新文案'],
  [/上次更新失败/, '区域错误不得再复制为全局可见错误']
]);
requirePatterns(globalStylesPath, globalStylesSource, [
  [/\.v2-sr-only\s*\{[\s\S]*clip:/, '共享加载状态缺少全局读屏专用工具类'],
  [/\.v2-page-state--loading\s*\{[\s\S]*width:\s*100%/, '加载骨架没有占满可用区域']
]);
requirePatterns(queryCachePath, queryCacheSource, [
  [/MAX_INACTIVE_QUERY_ENTRIES = 200/, '查询缓存缺少 200 条非活跃 LRU 保护'],
  [/INVALIDATION_COALESCE_MS = 100/, 'scope 失效没有在 100ms 内合并'],
  [/entry\.revalidateAt/, 'event-with-deadline 查询缺少 revalidateAt'],
  [/entry\.inFlight/, '同 scope 同 key 的并发请求没有复用'],
  [/requestedKey/, '查询状态没有记录当前请求参数 key'],
  [/displayedKey/, '查询状态没有记录当前展示快照 key'],
  [/isParameterTransition/, '查询状态无法区分参数切换和同参数刷新'],
  [/options\.enabled/, '查询缺少权限驱动的 enabled 门禁'],
  [/options\.trackRouteData/, '同路由多查询缺少数据就绪埋点归属门禁']
]);
forbidPatterns(queryCachePath, queryCacheSource, [
  [/TIER_FRESHNESS_MS/, '时间过去不得让 event-driven 缓存失效'],
  [/critical:\s*15_000|operational:\s*60_000|live:\s*30_000/, '不得恢复导航 TTL']
]);

for (const [pattern, message] of [
  [/const REFRESH_FEEDBACK_DELAY_MS = 120;/, '刷新反馈延迟必须固定为 120ms'],
  [/:aria-busy="isBusy"/, '异步区域缺少 aria-busy'],
  [/regionState === 'initial-loading'/, '异步区域缺少首次加载状态'],
  [/regionState === 'initial-error'/, '异步区域缺少首次失败状态'],
  [
    /v-if="[^"]*refresh-error[^"]*".+v2-async-region__refresh-error/s,
    '异步区域缺少保留内容后的刷新错误提示'
  ],
  [/v-if="showRefreshFeedback"/, '异步区域缺少延迟刷新反馈'],
  [/class="v2-async-region__progress"/, '异步区域缺少非遮挡式顶部进度线'],
  [/provide\(V2_ASYNC_REGION_PREVIOUS_DATA, isPreviousData\)/, '旧参数快照没有下发只读状态'],
  [/:data-v2-query-phase="effectivePhase"/, '异步区域没有暴露可验收的查询阶段'],
  [/prefers-reduced-motion/, '异步区域缺少减少动态效果支持']
]) {
  if (!pattern.test(asyncRegionSource)) issues.push(`${asyncRegionPath}: ${message}`);
}
requirePatterns(asyncRegionContextPath, asyncRegionContextSource, [
  [/InjectionKey<ComputedRef<boolean>>/, '旧参数快照的只读上下文缺少强类型约束']
]);
requirePatterns(appButtonPath, appButtonSource, [
  [/inject\(V2_ASYNC_REGION_PREVIOUS_DATA/, '操作按钮没有接入旧参数快照状态'],
  [/regionPreviousData\?\.value === true/, '旧参数快照下的操作按钮没有禁用']
]);
requirePatterns(asyncRegionStatePath, asyncRegionStateSource, [
  [/if \(phase === 'initial-error'\) return 'initial-error'/, '首次加载和失败状态不互斥'],
  [
    /if \(phase === 'idle' \|\| phase === 'initial-loading'\) return 'initial-loading'/,
    '首次加载和失败状态不互斥'
  ],
  [/if \(empty && phase !== 'transitioning'\) return 'empty'/, '成功空状态没有独立分支'],
  [/return phase === 'refreshing' \|\| phase === 'transitioning'/, '刷新反馈没有限制为已有成功内容']
]);
for (const [pattern, message] of [
  [/v2-async-region__overlay/, '禁止恢复浮动刷新卡片'],
  [/v2-async-region__spinner/, '读取反馈不得同时显示独立旋转指示器'],
  [/:inert="isPreviousData/, '旧参数快照不得锁死分页和恢复操作']
]) {
  if (pattern.test(asyncRegionSource)) issues.push(`${asyncRegionPath}: ${message}`);
}

if (issues.length) {
  console.error('V2 loading standard check failed:');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      ok: true,
      routedViews: uniqueRoutedViews.length,
      moduleKeys: moduleKeys.length,
      plannedPlaceholders: moduleKeys.length - readyModuleKeys.length,
      freshnessPolicies: [...allowedFreshnessPolicies],
      refreshFeedbackDelayMs: 120,
      asyncRegions: loadingVisualSummary.regionCount,
      contentSkeletonKinds: [...loadingVisualSummary.usedSkeletonKinds].sort(),
      singleIndicator: 'region-progress',
      routePrefetch: 'intent-only',
      performanceLifecycle: ['route-start', 'route-code-ready', 'route-data-ready'],
      chunkRecovery: 'reload-once-then-router-owned',
      exceptions: 0
    })
  );
}

function validateLoadingVisualArchitecture() {
  const sourceEntries = walkProjectFiles('apps/admin/src/v2')
    .filter((projectPath) => projectPath.endsWith('.vue'))
    .map((projectPath) => ({ projectPath, source: read(projectPath) }));
  const usedSkeletonKinds = new Set();
  let regionCount = 0;

  for (const { projectPath, source } of sourceEntries) {
    for (const match of source.matchAll(/<V2AsyncRegion\b[\s\S]*?>/g)) {
      regionCount += 1;
      const regionTag = match[0];
      const kind = regionTag.match(/\bskeleton=["']([a-z-]+)["']/)?.[1];
      if (!kind) {
        issues.push(`${projectPath}: 每个 V2AsyncRegion 必须显式声明内容形状 skeleton`);
      } else if (!allowedSkeletonKinds.has(kind)) {
        issues.push(`${projectPath}: V2AsyncRegion 使用了未知骨架类型 ${kind}`);
      } else {
        usedSkeletonKinds.add(kind);
      }
      if (/\b:previous-data=/.test(regionTag) && !/\b:phase=/.test(regionTag)) {
        issues.push(`${projectPath}: previous-data 必须与受控 phase 同时使用`);
      }
    }

    for (const tag of source.matchAll(/<AppButton\b[\s\S]*?>/g)) {
      if (
        /\b(?:title|aria-label)=["'][^"']*刷新[^"']*["']/.test(tag[0]) &&
        /\b:loading=/.test(tag[0])
      ) {
        issues.push(`${projectPath}: 读取刷新按钮不得与区域进度线同时显示 loading`);
      }
    }

    if (
      projectPath.startsWith(`${featuresPath}/`) &&
      !projectPath.endsWith('/order-entry/components/V2OrderEntryCandidates.vue') &&
      /\bv-model:current-page=/.test(source)
    ) {
      issues.push(`${projectPath}: 远程分页不得直接双向绑定请求页码`);
    }

    if (
      projectPath.startsWith(`${featuresPath}/`) &&
      /<V2PageState\b[^>]*\bstate=["']loading["']/.test(source)
    ) {
      issues.push(`${projectPath}: 业务组件不得绕过 V2AsyncRegion 直接拼装加载状态`);
    }
  }

  for (const kind of allowedSkeletonKinds) {
    if (!usedSkeletonKinds.has(kind)) {
      issues.push(`${featuresPath}: 内容形状骨架 ${kind} 没有被任何真实区域使用`);
    }
    if (!loadingVisualsSource.includes(`'${kind}'`)) {
      issues.push(`${loadingVisualsPath}: 缺少骨架类型 ${kind}`);
    }
  }

  requirePatterns(pageStatePath, pageStateSource, [
    [/V2ContentSkeleton/, '加载状态没有委托给统一内容形状骨架'],
    [/:kind="skeleton"/, '页面状态没有透传骨架类型'],
    [/role="status"/, '首次加载文案缺少无障碍状态播报']
  ]);
  forbidPatterns(pageStatePath, pageStateSource, [
    [/skeleton-toolbar|skeleton-table/, '页面状态仍内置固定表格骨架']
  ]);
  requirePatterns(contentSkeletonPath, contentSkeletonSource, [
    [/data-v2-skeleton/, '骨架缺少可验收的内容类型标记'],
    [/prefers-reduced-motion/, '骨架动画不支持减少动态效果'],
    [/v2-content-skeleton--\$\{kind\}/, '骨架根节点没有暴露内容类型样式']
  ]);

  return { regionCount, usedSkeletonKinds };
}

function validateViewSource(source, pageSource = source, requiresRemoteData = true) {
  const viewIssues = [];
  if (requiresRemoteData) {
    const required = [
      ['V2AsyncRegion', '没有使用 V2AsyncRegion'],
      [':phase=', '模块主查询没有把受控 phase 交给 V2AsyncRegion']
    ];
    for (const [snippet, message] of required) {
      if (!source.includes(snippet)) viewIssues.push(message);
    }
    if (!source.includes('useV2ModuleQuery')) {
      viewIssues.push('没有使用真实数据模块查询入口');
    }
  }
  const forbidden = [
    [/\bv-loading\s*=/, '禁止使用 v-loading'],
    [/<el-skeleton\b/, '禁止直接使用 el-skeleton'],
    [/\bElLoading\b/, '禁止使用 ElLoading'],
    [/\buseV2ActivationRefresh\b/, '禁止绕过模块级刷新入口'],
    [/\buseV2ModuleRefresh\b/, '禁止继续使用仅缓存完成标记的旧模块刷新入口'],
    [/<V2PageState\b[^>]*\bstate=["']loading["']/, '禁止直接拼装 loading 页面状态'],
    [/\bonActivated\s*\(\s*(?:load|async\s*\(\)\s*=>\s*load)/, '禁止激活页面时直接无条件加载'],
    [/\bv2-[^"']*(?:loading-overlay|switch-loading|page-loading)/, '禁止页面专用加载遮罩']
  ];
  for (const [pattern, message] of forbidden) {
    if (pattern.test(pageSource)) viewIssues.push(message);
  }
  return viewIssues;
}

function validateStartupArchitecture() {
  const files = {
    app: 'apps/admin/src/App.vue',
    apiClient: 'apps/admin/src/api/client.ts',
    apiError: 'apps/admin/src/api/apiError.ts',
    appRuntimeError: 'apps/admin/src/runtime/appRuntimeError.ts',
    auth: 'apps/admin/src/stores/auth.ts',
    bootGate: 'apps/admin/src/v2/components/V2BootGate.vue',
    entry: 'apps/admin/src/main.ts',
    html: 'apps/admin/index.html',
    bootScript: 'apps/admin/public/v2-boot.js',
    layout: 'apps/admin/src/v2/layouts/V2AdminLayout.vue',
    performance: 'apps/admin/src/runtime/performance.ts',
    query: 'apps/admin/src/v2/composables/useV2Query.ts',
    recovery: 'apps/admin/src/v2/runtime/preloadRecovery.ts',
    prefetch: 'apps/admin/src/v2/runtime/routePrefetch.ts',
    requestPolicy: 'apps/admin/src/api/requestPolicy.ts',
    router: 'apps/admin/src/v2-router.ts',
    routes: 'apps/admin/src/v2/router/routes.ts',
    sessionRecoveryQueries: 'apps/admin/src/v2/router/sessionRecoveryQueries.ts',
    credential: 'apps/admin/src/auth/credential.ts',
    sessionCoordinator: 'apps/admin/src/auth/sessionCoordinator.ts',
    orderEntryManifest: 'apps/admin/src/v2/features/order-entry/manifest.ts',
    vite: 'apps/admin/vite.config.ts'
  };
  const sources = Object.fromEntries(
    Object.entries(files).map(([key, projectPath]) => [key, read(projectPath)])
  );
  if (existsSync(path.join(rootDir, 'apps/admin/src/auth/session.ts'))) {
    issues.push(
      'apps/admin/src/auth/session.ts: 旧会话 shim 必须删除，会话真相只能由 SessionCoordinator 管理'
    );
  }

  requirePatterns(files.html, sources.html, [
    [/src="\/v2-boot\.js"/, 'HTML 没有加载外部启动恢复脚本'],
    [/class="v2-boot"/, '缺少路由中性的 HTML 启动占位'],
    [/正在安全打开页面/, 'HTML 启动占位没有使用统一安全加载文案']
  ]);
  requirePatterns(files.bootScript, sources.bootScript, [
    [/id-business-v2-theme/, '外部启动脚本缺少同步主题初始化'],
    [/vite:preloadError/, '外部启动脚本没有覆盖核心模块加载失败']
  ]);
  forbidPatterns(files.html, sources.html, [
    [/v2-boot__sidebar/, 'HTML 启动占位不得伪造工作区侧边栏'],
    [/v2-boot__nav/, 'HTML 启动占位不得伪造业务导航'],
    [/<table\b|<el-table\b/, 'HTML 启动占位不得伪造业务表格']
  ]);
  requirePatterns(files.bootGate, sources.bootGate, [
    [/正在安全打开页面/, 'Vue Boot Gate 没有复用统一安全加载文案']
  ]);
  forbidPatterns(files.bootGate, sources.bootGate, [
    [/has-workspace-placeholder|v2-boot-gate__workspace/, 'Boot Gate 不得临时伪造工作区']
  ]);

  requirePatterns(files.entry, sources.entry, [
    [/import\s+\{[^}]*createApp[^}]*\}\s+from\s+['"]vue['"]/, 'Vue 核心必须静态导入'],
    [/import\s+\{[^}]*createPinia[^}]*\}\s+from\s+['"]pinia['"]/, 'Pinia 必须静态导入'],
    [/import\s+App\s+from\s+['"].*App\.vue['"]/, 'App 必须静态导入'],
    [/import\s+\{[^}]*v2Router[^}]*\}\s+from\s+['"].*v2-router['"]/, 'Router 必须静态导入'],
    [/app\.mount\(/, 'V2 入口没有挂载应用']
  ]);
  forbidPatterns(files.entry, sources.entry, [
    [/\bawait\s+[^;]*(?:initializeSession|ensureSessionReady)\s*\(/s, '应用挂载前不得等待鉴权'],
    [/\bawait\s+[^;]*router\.isReady\s*\(/s, '应用挂载前不得等待路由就绪'],
    [/\belementPlusPlugin\b/, 'V2 不得安装旧版 Element Plus 运行时插件'],
    [/\bpreloadElementPlusComponents\b/, 'V2 不得预加载 Element Plus 组件合集'],
    [/element-plus\/es\/components\/[^'"]+\/style\//, 'V2 入口不得手工汇总组件样式'],
    [/element-plus\/dist\/index\.css/, 'V2 不得加载 Element Plus 全量 CSS']
  ]);

  for (const stage of [
    'booting',
    'session-checking',
    'route-loading',
    'ready',
    'degraded',
    'fatal'
  ]) {
    if (!sources.app.includes(`'${stage}'`)) {
      issues.push(`${files.app}: Boot Gate 缺少 ${stage} 状态`);
    }
  }
  requirePatterns(files.app, sources.app, [
    [/authIdentityEpoch/, '应用根节点没有以身份代次隔离组件运行态'],
    [/await router\.isReady\(\)/, '应用根节点没有收敛首次路由就绪结果'],
    [/navigateSafely/, 'Boot Gate 重试没有使用统一安全导航边界'],
    [
      /<V2BootGate[\s\S]*\/>\s*<RouterView v-else/,
      'Boot Gate 必须位于 RouterView 外层，避免首路由未解析时空白'
    ]
  ]);
  requirePatterns(files.query, sources.query, [
    [
      /sessionCoordinator\.subscribeIdentityChange\(ensureCacheIdentity\)/,
      '查询缓存没有订阅统一身份代际变化'
    ],
    [/resetQueryCache\(currentIdentityEpoch\)/, '身份变化时没有清理 V2 查询缓存']
  ]);
  forbidPatterns(files.app, sources.app, [
    [/currentRouteLoadError/, '路由资源错误不得再触发 V2App 全屏错误'],
    [/\bwatch\s*\(/, 'App 不得观察或修改会话路由状态'],
    [
      /subscribeAuthIdentityChange|clearV2QueryCache|resetV2RouteNavigationState/,
      'App 不得接管会话恢复或缓存清理'
    ],
    [
      /router\.isReady\(\)\.finally/,
      'router.isReady 拒绝不得通过 finally 泄漏为 unhandled rejection'
    ]
  ]);
  requirePatterns(files.appRuntimeError, sources.appRuntimeError, [
    [/isApiError/, 'API 错误没有交给结构化请求边界'],
    [/isNavigationFailure/, 'Vue Router 导航失败没有交给路由边界']
  ]);
  forbidPatterns(files.appRuntimeError, sources.appRuntimeError, [
    [
      /routeResourceErrorPatterns|failed to fetch dynamically imported module|couldn't resolve component/i,
      '应用级错误不得按路由错误文案正则分类'
    ]
  ]);

  requirePatterns(files.auth, sources.auth, [
    [/sessionCoordinator\.state/, 'auth store 没有直接暴露唯一 SessionCoordinator 状态'],
    [
      /ensureSessionReady:\s*sessionCoordinator\.ensureSession/,
      'auth store 缺少 ensureSessionReady'
    ]
  ]);
  forbidPatterns(files.auth, sources.auth, [
    [/\bSessionStatus\b|\bsessionStatus\b/, 'auth store 不得保留旧 sessionStatus 兼容层']
  ]);
  requirePatterns(files.sessionCoordinator, sources.sessionCoordinator, [
    [/validationPromise/, 'ensureSessionReady 缺少进行中请求复用'],
    [/mutableIdentityEpoch/, '身份变化后缺少统一代次'],
    [/isSameCredentialSnapshot/, '身份变化后缺少过期响应隔离'],
    [/abortIdentityRequests/, '身份变化后缺少进行中请求中止'],
    [/LEGAL_SESSION_TRANSITIONS/, '会话状态缺少显式合法转换图'],
    [/transitionSessionState/, '会话状态写入没有收敛到唯一 transition']
  ]);
  const directSessionWrites = [
    ...sources.sessionCoordinator.matchAll(/mutableSessionState\.value\s*=/g)
  ];
  if (directSessionWrites.length !== 2) {
    issues.push(
      `${files.sessionCoordinator}: 除 transition 和测试 reset 外不得直接写会话状态，当前 ${directSessionWrites.length} 处`
    );
  }
  requirePatterns(files.credential, sources.credential, [
    [/apple_business_auth_v2/, '会话凭据没有收敛为单一原子 V2 记录'],
    [/tokenRevision/, '原子凭据缺少 token 修订隔离'],
    [/getBrowserStorage\('sessionStorage'\)/, '凭据没有使用标签页级会话存储'],
    [/const storage = globalThis\[name\]/, '凭据存储没有兼容 SSR 和无存储测试环境']
  ]);
  requirePatterns(files.requestPolicy, sources.requestPolicy, [
    [/ENDPOINT_POLICIES/, '会话例外没有通过结构化 endpoint registry 声明'],
    [/pathname === ['"][/]auth[/]me['"]/, 'auth/me 缺少精确端点重试策略']
  ]);
  forbidPatterns(files.requestPolicy, sources.requestPolicy, [
    [/\.includes\s*\(/, '不得用 URL 子串匹配会话例外或重试策略']
  ]);
  requirePatterns(files.apiClient, sources.apiClient, [
    [/new ApiError/, '客户端错误没有收敛为 ApiError'],
    [/assertWriteAllowed/, '非安全请求没有经过中央会话写门禁']
  ]);
  requirePatterns(files.vite, sources.vite, [
    [/unplugin-auto-import\/vite/, 'V2 未配置 unplugin-auto-import'],
    [/unplugin-vue-components\/vite/, 'V2 未配置 unplugin-vue-components'],
    [/ElementPlusResolver/, 'V2 未配置 ElementPlusResolver']
  ]);
  requirePatterns(files.recovery, sources.recovery, [
    [/vite:preloadError/, '缺少 Vite preload error 监听'],
    [/buildId/, 'Chunk 恢复缺少构建版本隔离'],
    [/sessionStorage/, 'Chunk 恢复缺少会话级防循环记录'],
    [/hasStableRoute/, 'Chunk 恢复没有区分已有稳定页面']
  ]);
  requirePatterns(files.recovery, sources.recovery, [
    [/defer-to-router/, '稳定页面的 Chunk 错误没有交还给真实路由或意图调用方'],
    [
      /if \(action === 'defer-to-router'\)[\s\S]*?return;[\s\S]*?event\.preventDefault\(\)/,
      '稳定页面的预取错误仍被全局恢复器拦截并误报'
    ]
  ]);
  requirePatterns(files.prefetch, sources.prefetch, [
    [/V2_HOVER_PREFETCH_DELAY_MS/, '悬停预取缺少可取消的意图延迟'],
    [/connection\?\.saveData/, '意图预取没有尊重省流量设置'],
    [/slow-2g[\s\S]*2g/, '意图预取没有规避慢速网络'],
    [/pointerdown/, '触摸或鼠标确认导航时缺少即时预取'],
    [/cancel\(/, '意图预取缺少离开目标后的取消入口']
  ]);
  requirePatterns(files.layout, sources.layout, [
    [/createV2RoutePrefetchController/, '布局没有使用统一意图预取控制器'],
    [/@pointerenter=/, '导航缺少悬停意图'],
    [/@pointerleave=/, '导航离开后没有取消未开始的预取'],
    [/@focus=/, '键盘导航缺少聚焦意图'],
    [/@pointerdown=/, '确认点击时没有立即启动目标 Chunk']
  ]);
  requirePatterns(files.routes, sources.routes, [
    [/markV2RoutePrefetch/, '路由 Chunk 预取缺少开始、成功和失败观测'],
    [
      /Promise\.all\(\[layoutLoader\(\), getModuleView\(moduleKey\)\(\)\]\)/,
      '预取没有复用路由注册表'
    ]
  ]);
  requirePatterns(files.performance, sources.performance, [
    [/v2:route-code-ready/, '性能埋点缺少路由代码就绪阶段'],
    [/v2:route-data-ready/, '性能埋点缺少业务数据就绪阶段'],
    [/v2:route-code-to-data-duration/, '性能埋点无法测量代码到数据的等待'],
    [/navigationId/, '性能埋点缺少导航代际，无法隔离迟到响应']
  ]);
  forbidPatterns(files.performance, sources.performance, [
    [/'v2:route-ready'/, '禁止把 afterEach 重新命名为含糊的 route-ready']
  ]);
  requirePatterns(files.router, sources.router, [
    [/beginV2RoutePerformance\(to\.path\)/, '路由开始没有建立独立性能代际'],
    [/markV2RouteCodeReady/, 'afterEach 没有只记录代码就绪'],
    [/resetV2RouteNavigationState/, '非 V2 跳转没有清理旧工作区加载状态'],
    [/watch\([\s\S]*sessionState/, '路由层没有统一观察会话恢复'],
    [/invalidateV2SessionRecoveryQueries/, '会话恢复后没有触发已保留查询刷新'],
    [/restoreVerifiedRoute/, '已验证降级时没有保留原工作区路由']
  ]);
  forbidPatterns(files.router, sources.router, [
    [/return false;/, '会话守卫不得通过 return false 中止导航']
  ]);
  requirePatterns(files.sessionRecoveryQueries, sources.sessionRecoveryQueries, [
    [/invalidateV2Queries\(V2_DATA_SCOPES\)/, '会话恢复后没有失效并刷新已保留查询']
  ]);
  requirePatterns(files.routes, sources.routes, [
    [/export function resetV2RouteNavigationState/, '路由状态缺少显式重置入口']
  ]);
  requirePatterns(files.query, sources.query, [
    [/markV2RouteDataReady/, '真实模块查询没有上报业务数据就绪'],
    [/markV2RouteDataError/, '首次数据失败没有结束性能等待']
  ]);
  forbidPatterns(files.query, sources.query, [
    [/localStorage|sessionStorage|indexedDB/i, '敏感查询缓存不得写入浏览器持久化存储']
  ]);
  forbidPatterns(files.routes, sources.routes, [
    [/@\/plugins\/element-plus/, 'V2 路由仍依赖旧版 Element Plus 插件'],
    [/V2_WORKSPACE_COMPONENTS|V2_LOGIN_COMPONENTS/, 'V2 路由仍预加载组件合集']
  ]);
  forbidPatterns(files.layout, sources.layout, [
    [/scheduleIdlePrefetch|requestIdleCallback/, '布局不得空闲批量预取全部 V2 页面'],
    [/V2_PAGE_CACHE_LIMIT\s*=\s*v2ModuleDefinitions\.length/, '布局不得 KeepAlive 全部 V2 页面']
  ]);
  requirePatterns(files.layout, sources.layout, [
    [/viewRoute\.meta\.keepAlive/, '布局缺少按路由声明选择性 KeepAlive'],
    [
      /filter\([\s\S]*'keepAlive' in module[\s\S]*module\.keepAlive === true/,
      'KeepAlive 上限没有由显式草稿页面计算'
    ]
  ]);
  requirePatterns(files.routes, sources.routes, [
    [/keepAlive:\s*'keepAlive' in module/, '路由没有透传选择性 KeepAlive 声明']
  ]);
  requirePatterns(files.orderEntryManifest, sources.orderEntryManifest, [
    [/keepAlive:\s*true/, '订单录入没有声明内存草稿保留']
  ]);
}

function requirePatterns(projectPath, source, patterns) {
  for (const [pattern, message] of patterns) {
    if (!pattern.test(source)) issues.push(`${projectPath}: ${message}`);
  }
}

function forbidPatterns(projectPath, source, patterns) {
  for (const [pattern, message] of patterns) {
    if (pattern.test(source)) issues.push(`${projectPath}: ${message}`);
  }
}

function runSelfTests() {
  const valid =
    '<V2AsyncRegion skeleton="table" :phase="query.phase" /><script>useV2ModuleQuery({ moduleKey: \'orders\' })</script>';
  assert.deepEqual(validateViewSource(valid), []);
  for (const snippet of [
    'v-loading="loading"',
    '<el-skeleton />',
    'ElLoading.service()',
    'useV2ActivationRefresh({})',
    'useV2ModuleRefresh({})',
    '<V2PageState state="loading" />',
    'onActivated(loadData)',
    'class="v2-page-loading-overlay"'
  ]) {
    assert.ok(validateViewSource(`${valid}${snippet}`).length > 0);
  }
}

function read(projectPath) {
  return readFileSync(path.join(rootDir, projectPath), 'utf8');
}

function collectLocalSources(projectPath, visited = new Set()) {
  if (visited.has(projectPath)) return [];
  visited.add(projectPath);

  const source = read(projectPath);
  const sources = [source];
  const importPattern = /from\s+['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) {
    const importPath = match[1];
    const basePath = path.posix.normalize(
      path.posix.join(path.posix.dirname(projectPath), importPath)
    );
    const candidates = path.posix.extname(basePath)
      ? [basePath]
      : [`${basePath}.ts`, `${basePath}.vue`, `${basePath}/index.ts`];
    const resolvedPath = candidates.find((candidate) => existsSync(path.join(rootDir, candidate)));
    if (resolvedPath) sources.push(...collectLocalSources(resolvedPath, visited));
  }
  return sources;
}

function walkProjectFiles(projectPath) {
  const absolutePath = path.join(rootDir, projectPath);
  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const childPath = path.posix.join(projectPath, entry.name);
    return entry.isDirectory() ? walkProjectFiles(childPath) : [childPath];
  });
}
