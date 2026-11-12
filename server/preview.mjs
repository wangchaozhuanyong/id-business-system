import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { installFinanceAssets } from './finance/preview-assets.mjs';
import { createFinanceQuoteService } from './finance/quote-service.mjs';
import { createFinanceCollection } from './finance/collection-service.mjs';
import { financeCollectionRoute, createFinanceCollectionHandler } from './finance/collection-route.mjs';
import { orderExpenseRoute, createOrderExpenseHandler } from './finance/expense-receipts.mjs';
import { automaticSnapshotRoute, createAutomaticSnapshotHandler } from './finance/quote-route.mjs';
import { createWebsiteMonitor, handleWebsiteMonitor } from './tools/website-monitor.mjs';
import { createBitBrowserProxyExtraction } from './bitbrowser-proxy-extraction.mjs';
import { createWebsiteAnalytics } from './tools/website-analytics.mjs';
import { createWebsiteVisits } from './tools/website-visits.mjs';
import { createSheetsStatusHandler, sheetsStatusRoute } from './tools/sheets-status.mjs';
import { createMediaResolver } from './tools/media-resolver.mjs';
import {
  createManagedMailboxQuery, managedMailboxQueryRoute, storefrontMailboxQueryRoute, verifyMailboxImap
} from './tools/mailbox-pool.mjs';
import { parseToolPublicOrigin } from './tools/request-origin.mjs';
import { createMicrosoftMailbox, legacyMicrosoftMailboxCallback, microsoftMailboxPrefix } from './tools/mailbox-microsoft.mjs';
import { createLegacyToolRoutes, legacyWebsiteVisitIngest } from './tools/legacy-public-routes.mjs';
import { readToolConfig } from './tools/read-tool-config.mjs';
import { createLocalCodexdaichongGateway } from '../modules/recharge/codexdaichong/local-gateway.mjs';
import { loadCodexdaichongAssets } from '../modules/recharge/codexdaichong/assets.mjs';
import { vendureRechargePrefix } from '../modules/recharge/vendure/loopback-bridge.mjs';
import { listenStorefrontAdmission } from '../modules/recharge/vendure/admission.mjs';
import { productionDataPaths } from './production-data.mjs';
import { createOrderRechargeClient, readPoolCards } from './order-recharge-client.mjs';
import { createOrderAuxiliaryHandler, orderAuxiliaryRoutes } from './order-auxiliary.mjs';
import {
  cardManagementRoutes, checkFrozenCardPoolWrite, createCardManagementHandler, preserveReferencedOrderCard
} from './card-management.mjs';
import { claudeGoogleSubscriptionRoutes, createClaudeGoogleSubscriptionsHandler } from './claude-google-subscriptions.mjs';
import { createSubscriptionHandler, subscriptionRoutes } from './subscription-management.mjs';
import { createRechargeCodeHandler, rechargeCodesRoute } from './recharge-code-requests.mjs';
import { createRechargeOrderSync, orderSyncRoute } from './recharge-order-sync.mjs';
import { createRechargeActivity, rechargeActivityDomain, rechargeActivityRoute } from './recharge-activity.mjs';
import { createDataChangeStream, dataChangeRoute } from './change-sync.mjs';
import { createEmployeeStatisticsHandler, employeeStatisticsRoute } from './employee-statistics.mjs';
import { monitorPath, monitorConfigDomain, monitorReportPath, readyPath } from './monitoring-policy.mjs';
import { createSystemMonitoring } from './system-monitoring.mjs';
import { createMonitoringSources } from './monitoring-sources.mjs';
import { createMonitoringHandler, createMonitoringReadiness, createProbeReportHandler } from './monitoring-route.mjs';
import { createLegacyRechargeNotifications } from './monitoring-recharge.mjs';
import { probeCodexdaichongRuntime } from '../modules/recharge/codexdaichong/runtime-health.mjs';
import { createRechargeEvents } from './recharge-events.mjs';

const publicAssetTypes = new Set(['text/css; charset=utf-8', 'text/javascript; charset=utf-8']);

const files = new Map([
  ['index.html', 'text/html; charset=utf-8'],
  ['prototype.css', 'text/css; charset=utf-8'],
  ['design-tokens.css', 'text/css; charset=utf-8'],
  ['tabs.css', 'text/css; charset=utf-8'],
  ['design-charts.css', 'text/css; charset=utf-8'],
  ['design-charts.js', 'text/javascript; charset=utf-8'],
  ['interaction-preferences.css', 'text/css; charset=utf-8'],
  ['interaction-preferences.js', 'text/javascript; charset=utf-8'],
  ['pagination.css', 'text/css; charset=utf-8'],
  ['title-help.css', 'text/css; charset=utf-8'],
  ['overview-prototype.css', 'text/css; charset=utf-8'],
  ['data-center.css', 'text/css; charset=utf-8'],
  ['sheets-status.css', 'text/css; charset=utf-8'],
  ['finance-collection.css', 'text/css; charset=utf-8'],
  ['recharge-integration.css', 'text/css; charset=utf-8'],
  ['recharge-activity.css', 'text/css; charset=utf-8'],
  ['bitbrowser-addresses.css', 'text/css; charset=utf-8'],
  ['order-opening.mjs', 'text/javascript; charset=utf-8'],
  ['list-order.mjs', 'text/javascript; charset=utf-8'],
  ...[
    'prototype',
    'pagination',
    'overview-prototype',
    'finance-collection',
    'title-help',
    'inventory-prototype',
    'apple-relay-prototype',
    'apple-balance-prototype',
    'commerce-prototype',
    'claude-google-subscriptions',
    'subscription-management',
    'employee-statistics',
    'order-operations',
    'order-completion',
    'recharge-activity',
    'change-sync',
    'search-input',
    'operations-prototype',
    'data-center',
    'sheets-status',
    'system-monitoring',
    'bitbrowser-addresses'
  ].map((name) => [name + '.js', 'text/javascript; charset=utf-8'])
]);

function publicAssetMetadata(body) {
  const etag = 'W/"' + createHash('sha256').update(body).digest('hex') + '"';
  const gzip = body.length >= 1024 ? gzipSync(body) : undefined;
  return { etag, gzip: gzip && gzip.length < body.length ? gzip : undefined };
}

function acceptsGzip(value = '') {
  const encodings = value.split(',').map((entry) => entry.toLowerCase().trim().split(/\s*;\s*/));
  const selected = encodings.find(([name]) => name === 'gzip') ??
    encodings.find(([name]) => name === '*');
  if (!selected) return false;
  const quality = selected[1];
  if (quality === undefined) return true;
  const match = /^q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.exec(quality);
  return Boolean(match && Number(match[1]) > 0);
}

function sendPublicAsset(request, response, asset) {
  const { etag, gzip } = asset.publicMetadata;
  response.setHeader('Cache-Control', 'public, no-cache');
  response.setHeader('ETag', etag);
  if (gzip) response.setHeader('Vary', 'Accept-Encoding');

  const matches = request.headers['if-none-match']?.split(',').some((value) => {
    const tag = value.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag.slice(2);
  });
  if (matches) return response.writeHead(304).end();

  const compressed = gzip && acceptsGzip(request.headers['accept-encoding']);
  const body = compressed ? gzip : asset.body;
  if (compressed) response.setHeader('Content-Encoding', 'gzip');
  response.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': body.length });
  response.end(request.method === 'HEAD' ? undefined : body);
}

export async function startPreview(
  port = 4347,
  {
    codexdaichong,
    rechargeConfig,
    rechargeEventsConfig,
    vendureRehearsal,
    databasePath,
    authPath,
    publicOrigin,
    bootstrapLocalAdmin = false,
    relayConfig,
    relayFetch,
    financeProvider,
    financeFetch,
    mediaResolverUrl,
    mediaFetch,
    websiteAnalyticsConfig,
    websiteCloudflareConfig,
    websiteAnalyticsFetch,
    websiteVisitsSecret,
    readManagedMailbox,
    mailboxPublicOrigin,
    microsoftMailboxConfig,
    microsoftMailboxFetch,
    storefrontAdmissionDirectory = process.env.ID_VENDURE_ADMISSION_DIRECTORY,
    rechargeOrderSync = Boolean(publicOrigin && rechargeConfig),
    monitoringProbeSecret = process.env.ID_MONITOR_PROBE_SECRET,
    monitoringWorkerReceiptsDirectory = process.env.ID_MONITOR_WORKER_RECEIPTS_DIR,
    monitoringBackupReceiptsDirectory = process.env.ID_MONITOR_BACKUP_RECEIPTS_DIR
  } = {}
) {
  const publicUrl = parseToolPublicOrigin(publicOrigin);
  const secureOrigin = publicUrl?.origin;
  if (publicUrl && (!databasePath || !authPath || bootstrapLocalAdmin || codexdaichong))
    throw new Error('正式站必须使用独立业务库、预先初始化的员工账号和统一登录');
  if (vendureRehearsal && (publicUrl || typeof vendureRehearsal.handle !== 'function'))
    throw new Error('Vendure 演练适配器仅可挂载到独立回环站');
  const mailboxPublicUrl = parseToolPublicOrigin(mailboxPublicOrigin);
  if (mailboxPublicUrl && (!databasePath || !authPath))
    throw new Error('商城邮箱查询需要独立业务库和账号配置');
  if (bootstrapLocalAdmin && (!databasePath || !authPath))
    throw new Error('首次设置管理员需要本机数据库和账号文件');
  if (rechargeConfig && (!databasePath || !authPath || codexdaichong))
    throw new Error('本机线上代充需要本机业务模式和统一会话');
  if (storefrontAdmissionDirectory && (!databasePath || !rechargeConfig))
    throw new Error('商城准入查询需要业务发码记录和原版代充连接');
  const rechargeAssets = publicUrl && rechargeConfig
    ? await loadCodexdaichongAssets({ requireBundle: true })
    : undefined;
  if (mediaResolverUrl && (!databasePath || !authPath))
    throw new Error('作品解析需要本机业务模式和统一会话');
  const handleMediaResolver = createMediaResolver({
    url: mediaResolverUrl,
    publicOrigin: secureOrigin,
    fetchWorker: mediaFetch
  });
  const handleWebsiteAnalytics = createWebsiteAnalytics({
    config: websiteAnalyticsConfig,
    cloudflareConfig: websiteCloudflareConfig,
    publicOrigin: secureOrigin,
    fetchImpl: websiteAnalyticsFetch
  });
  const handleSheetsStatus = createSheetsStatusHandler({
    receiptDirectory: monitoringWorkerReceiptsDirectory,
    collectorDirectory: monitoringBackupReceiptsDirectory,
    dataDirectory: databasePath ? dirname(databasePath) : undefined,
    publicOrigin: secureOrigin
  });
  const extractBitProxy = createBitBrowserProxyExtraction({ publicOrigin: secureOrigin });
  const monitorWebsite = publicUrl ? createWebsiteMonitor({ publicOrigin: secureOrigin }) : handleWebsiteMonitor;
  const assets = new Map(
    await Promise.all(
      [...files].map(async ([file, type]) => {
        const body = await readFile(new URL('../frontend/' + file, import.meta.url));
        const publicMetadata = publicAssetTypes.has(type) ? publicAssetMetadata(body) : undefined;
        return ['/' + file, { type, body, publicMetadata }];
      })
    )
  );
  assets.set('/apple-funding.mjs', { type: 'text/javascript; charset=utf-8',
    body: await readFile(new URL('../frontend/apple-funding.mjs', import.meta.url)) });
  const localBitAssets = [
    ['/assets/bitbrowser/authorization.mjs', '../modules/recharge/bitbrowser/authorization.mjs'],
    ['/assets/bitbrowser/catalog.mjs', '../modules/recharge/bitbrowser/catalog.mjs'],
    ...['countries', 'proxy-input', 'proxy-test', 'proxy-extraction', 'proxy-types'].map(name => [`/assets/bitbrowser/${name}.mjs`, `../modules/recharge/bitbrowser/${name}.mjs`]),
    ['/assets/bitbrowser/local.mjs', '../frontend/bitbrowser-local.mjs'],
    ['/assets/bitbrowser/proxies.mjs', '../frontend/bitbrowser-proxies.mjs'],
    ...['index', 'direct-login', 'direct-api', 'browser-options', 'cdp', 'login-page'].map(
      (name) => [
        `/assets/bitbrowser/login/${name}.mjs`,
        `../modules/recharge/bitbrowser/login/${name}.mjs`
      ]
    )
  ];
  for (const [route, file] of localBitAssets) {
    assets.set(route, {
      type: 'text/javascript; charset=utf-8',
      body: await readFile(new URL(file, import.meta.url))
    });
  }
  const bitLoginHtml = await readFile(
    new URL('../frontend/bitbrowser-local.html', import.meta.url),
    'utf8'
  );
  const localBitCheck = Buffer.from(
    databasePath
      ? bitLoginHtml.replace(
          '<body class="bit-local">',
          '<body class="bit-local" data-connection-profiles>'
        )
      : bitLoginHtml
  );
  const localBusiness = databasePath ? await import('./local-business.mjs') : null;
  let store = null;
  let handleManagedMailboxQuery;
  let microsoftMailbox;
  let handleWebsiteVisits;
  let handleLegacyToolRoute;
  let auth = null;
  let loadAuth = null;
  let setupAdmin = null;
  let relay = null;
  let signedOutIndex = null;
  let setupIndex = null;
  let handleAutomaticSnapshot = null;
  let financeCollection = null, handleFinanceCollection = null, handleOrderExpense = null;
  let handleOrderAuxiliary, handleCardManagement, handleClaudeGoogleSubscriptions, handleSubscriptions, handleRechargeCodes, orderSync;
  let rechargeActivity, rechargeEvents;
  let handleEmployeeStatistics;
  let systemMonitoring, monitoringSources, handleMonitoring, handleProbeReport, handleReadiness;
  const orderRechargeClient = createOrderRechargeClient(rechargeConfig);
  const gateways = new Map();
  const cardPlanEpoch = Date.now().toString(36);
  let cardPlanVersion = 0;
  function gatewayFor(host) {
    if (!rechargeConfig) return codexdaichong;
    if (!gateways.has(host)) {
      gateways.set(
        host,
        createLocalCodexdaichongGateway({
          assets: rechargeAssets ? () => rechargeAssets : undefined,
          upstreamUrl: rechargeConfig.upstreamUrl,
          publicOrigin: secureOrigin || `http://${host}`,
          secret: rechargeConfig.secret,
          legacyNotificationLocked: () => systemMonitoring?.legacyLocked() === true,
          beforeCardDelete: (cardId, actor) => {
            if (!store) throw new Error('订单资料尚未就绪');
            return preserveReferencedOrderCard(store, orderRechargeClient, cardId, actor);
          },
          beforeCardWrite: command => {
            if (!store) throw new Error('订单资料尚未就绪');
            checkFrozenCardPoolWrite(store, command);
          },
          onCardPlanChange(version) {
            if (version <= cardPlanVersion) return;
            cardPlanVersion = version;
            store?.notifyChanges();
          },
          onRechargeOutcome: outcome => queueMicrotask(() => {
            try { monitoringSources?.recordRecharge(outcome); } catch {}
          }),
          getActor: (request) => auth?.getActor(request)
        })
      );
    }
    return gateways.get(host);
  }
  if (rechargeConfig) gatewayFor(publicUrl?.host || `127.0.0.1:${port}`);
  if (localBusiness) {
    try {
      if (authPath) {
        const { createLocalAuth, createLocalAdminSetup, localAdminEmail } = await import('./local-auth.mjs');
        loadAuth = () => createLocalAuth(authPath, {
          onEvent: (event) => store.recordAuthEvent(event),
          onMonitoring: publicUrl ? (event) => queueMicrotask(() => monitoringSources?.recordAuth(event)) : undefined,
          publicUrl
        });
        auth = loadAuth();
        if (publicUrl && !auth) throw new Error('正式站管理员尚未初始化');
        if (bootstrapLocalAdmin && !auth) setupAdmin = {
          handle: createLocalAdminSetup(authPath, {
            onCreated: (actor) => store.recordAuthEvent({ action: 'auth_employee_create', actor, targetId: actor.id })
          }),
          email: localAdminEmail
        };
      }
      store = localBusiness.createLocalBusinessStore(databasePath);
      if (rechargeConfig) rechargeActivity = createRechargeActivity({
        store, client: orderRechargeClient, publicOrigin: secureOrigin, getActor: request => auth?.getActor(request)
      });
      systemMonitoring = createSystemMonitoring({ store, origin: secureOrigin,
        native: rechargeConfig ? createLegacyRechargeNotifications(orderRechargeClient) : undefined,
        send: publicUrl ? undefined : async () => ({ status: 'failed', reason: 'configuration' }) });
      handleMonitoring = createMonitoringHandler({ monitor: systemMonitoring, publicOrigin: secureOrigin });
      if (publicUrl) {
        const externalProbe = typeof monitoringProbeSecret === 'string' && Buffer.byteLength(monitoringProbeSecret) >= 32;
        handleReadiness = createMonitoringReadiness({ check() {
          if (!auth?.ready()) return false;
          store.featureDocument(monitorConfigDomain);
          return true;
        } });
        handleProbeReport = createProbeReportHandler({ monitor: systemMonitoring, secret: monitoringProbeSecret });
        monitoringSources = createMonitoringSources({ monitor: systemMonitoring, databasePath, externalProbe,
          workerReceiptDirectory: monitoringWorkerReceiptsDirectory,
          backupReceiptDirectory: monitoringBackupReceiptsDirectory,
          runtimeProbe: rechargeConfig ? () => probeCodexdaichongRuntime(rechargeConfig) : undefined,
          rechargeClient: orderRechargeClient, getFinance: () => financeCollection,
          syncEnabled: Boolean(rechargeConfig && rechargeOrderSync), syncViaEvents: Boolean(rechargeEventsConfig) });
      }
      handleOrderAuxiliary = createOrderAuxiliaryHandler({ store, client: orderRechargeClient, publicOrigin: secureOrigin });
      handleCardManagement = createCardManagementHandler({ store, client: orderRechargeClient, publicOrigin: secureOrigin });
      handleClaudeGoogleSubscriptions = createClaudeGoogleSubscriptionsHandler({ store, publicOrigin: secureOrigin });
      handleSubscriptions = createSubscriptionHandler({ store, publicOrigin: secureOrigin,
        readOwners: () => auth?.orderOwners() || [] });
      handleEmployeeStatistics = createEmployeeStatisticsHandler({
        store, client: orderRechargeClient, publicOrigin: secureOrigin, readEmployees: () => auth.orderOwners()
      });
      handleRechargeCodes = createRechargeCodeHandler({
        store: {
          load: () => store.featureDocument('recharge-codes'),
          save: (version, data, audit) => store.saveFeatureDocument('recharge-codes', version, data, audit)
        },
        transport: orderRechargeClient,
        publicOrigin: secureOrigin
      });
      handleWebsiteVisits = createWebsiteVisits({ store, secret: websiteVisitsSecret, publicOrigin: secureOrigin });
      microsoftMailbox = createMicrosoftMailbox({
        store, config: microsoftMailboxConfig, publicOrigin: secureOrigin,
        fetchImpl: microsoftMailboxFetch, readImap: readManagedMailbox
      });
      handleManagedMailboxQuery = createManagedMailboxQuery({
        store, publicOrigin: secureOrigin, storefrontOrigin: mailboxPublicUrl?.origin,
        readMailbox: microsoftMailbox.readMailbox, watchMailbox: microsoftMailbox.watchMailbox
      });
      if (publicUrl) handleLegacyToolRoute = createLegacyToolRoutes({
        publicOrigin: secureOrigin, microsoftMailbox, handleWebsiteVisits
      });
      const { createAppleRelayService } = await import('./apple-relay/local-service.mjs');
      relay = createAppleRelayService({
        config: relayConfig,
        publicOrigin: secureOrigin,
        readInventory: () => store.load('inventory').data,
        subscribeChanges: listener => store.subscribeChanges(listener),
        planIntake: (input) => store.planAppleRelayIntake(input),
        savePrimaries: (rows, actor, aliases, registration) =>
          store.saveAppleRelayPrimaries(rows, actor, aliases, registration),
        fetchImpl: relayFetch,
        recordAction: ({ action, actor, parentId, aliasId }) =>
          store.recordAuthEvent({ action: 'relay_' + action, actor, targetId: aliasId || parentId }),
        recordActions: events => store.recordAuthEvents(events.map(({ action, actor, parentId, aliasId }) =>
          ({ action: 'relay_' + action, actor, targetId: aliasId || parentId })))
      });
      for (const [name, type] of [
        ['local-data.js', 'text/javascript; charset=utf-8'],
        ['toolbox-local.js', 'text/javascript; charset=utf-8'],
        ['local-auth.js', 'text/javascript; charset=utf-8'],
        ['local-auth.css', 'text/css; charset=utf-8'],
        ['apple-relay-public.js', 'text/javascript; charset=utf-8'],
        ['apple-relay-public.css', 'text/css; charset=utf-8']
      ]) {
        const body = await readFile(new URL('../frontend/' + name, import.meta.url));
        assets.set('/' + name, { type, body });
      }
      assets.set('/mailbox-query', {
        type: 'text/html; charset=utf-8',
        body: await readFile(new URL('../frontend/apple-relay-public.html', import.meta.url))
      });
      assets.set('/assets/tools/totp.mjs', {
        type: 'text/javascript; charset=utf-8',
        body: await readFile(new URL('../modules/tools/totp.mjs', import.meta.url))
      });
    } catch (error) {
      store?.close();
      throw error;
    }
    const index = assets.get('/index.html');
    const localIndex = index.body
      .toString('utf8')
      .replace(
        '    <script src="./prototype.js',
        '    <link rel="stylesheet" href="/local-auth.css" />\n' +
          '    <script src="/local-data.js" defer></script>\n' +
          '    <script src="/toolbox-local.js" defer></script>\n' +
          '    <script src="/local-auth.js" defer></script>\n    <script src="./prototype.js'
      )
      .replace('20261105-bit-login" />', '20261106-local-inventory-settings" />')
      .replace(
        '<title>ID 业务管理 · 新版交互设计</title>',
        publicUrl ? '<title>ID 业务管理系统</title>' : '<title>ID 业务管理 · 独立本机测试</title>'
      )
      .replace('页面设计预览 · 所有资料均为虚构示例', publicUrl ? '业务管理系统' : '本机业务模式 · 未接入的模块仍为演示');
    index.body = Buffer.from(localIndex);
    try {
      financeCollection = createFinanceCollection({ store, provider: financeProvider, fetchQuote: financeFetch });
      handleFinanceCollection = createFinanceCollectionHandler({ collection: financeCollection, publicOrigin: secureOrigin });
      handleOrderExpense = createOrderExpenseHandler({ store, publicOrigin: secureOrigin });
      const quoteService = createFinanceQuoteService({
        provider: financeProvider,
        fetchQuote: financeFetch, collection: financeCollection
      });
      handleAutomaticSnapshot = createAutomaticSnapshotHandler({ store, quoteService, publicOrigin: secureOrigin });
      orderSync = createRechargeOrderSync({ store, client: orderRechargeClient, quoteService, publicOrigin: secureOrigin,
        background: Boolean(rechargeOrderSync && rechargeConfig),
        onStatus: success => monitoringSources?.recordOrderSync(success) });
      if (rechargeEventsConfig) rechargeEvents = createRechargeEvents({ config: rechargeEventsConfig,
        store, orderSync, activity: rechargeActivity, onReaderStatus: state => monitoringSources?.recordOrderSyncReader(state) });
      await installFinanceAssets(assets, { automaticQuotes: true });
    } catch (error) {
      financeCollection?.close();
      store.close();
      throw error;
    }
    if (loadAuth) {
      signedOutIndex = Buffer.from(
        localIndex
          .replace('<head>', '<head>\n    <meta name="id-local-auth" content="required" />')
          .replace(/^ *<script src="\.\/[^"\n]+" defer><\/script>\n/gm, '')
          .replace('<div class="app-shell">', '<div class="app-shell" hidden>')
          .replace('<a class="skip-link"', '<a hidden class="skip-link"')
      );
      if (setupAdmin) {
        setupIndex = Buffer.from(signedOutIndex.toString('utf8').replace(
          '<head>',
          `<head>\n    <meta name="id-local-admin-setup" content="${setupAdmin.email}" />`
        ));
      }
    }
  }
  function allowsHost(host, port) {
    return publicUrl ? host === publicUrl.host : ['127.0.0.1:' + port, 'localhost:' + port].includes(host);
  }
  const dataChanges = store ? createDataChangeStream({
    getActor: request => auth?.getActor(request, { throwOnUnavailable: true }) || (!authPath && !publicUrl
      ? { id: 'local-operator', role: 'admin' } : null),
    getVersions: actor => {
      const versions = { ...store.changeVersions(actor), operators: auth?.changeVersion() || '0',
        ...(rechargeActivity && { [rechargeActivityDomain]: rechargeActivity.version(actor) }) };
      for (const [scope, revision] of Object.entries(rechargeEvents?.versions() || {}))
        if (Object.hasOwn(versions, scope)) versions[scope] += ':' + revision;
      if (systemMonitoring && Object.hasOwn(versions, 'system-monitoring'))
        versions['system-monitoring'] += ':' + systemMonitoring.changeVersion();
      if (rechargeConfig && actor.role === 'super')
        versions['recharge-card-plans'] = cardPlanEpoch + ':' + cardPlanVersion;
      return versions;
    },
    subscribe: listener => {
      const stopStore = store.subscribeChanges(listener);
      const stopSamples = systemMonitoring?.subscribeChanges(listener);
      return () => { stopStore(); stopSamples?.(); };
    },
    watchPaths: [
      ...(databasePath && databasePath !== ':memory:' ? [databasePath, databasePath + '-wal', databasePath + '-journal'] : []),
      ...(authPath ? [authPath] : [])
    ]
  }) : null;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-ID-Workspace', 'independent-redesign-20261105');
    const address = server.address();
    const route = (request.url || '/').split('?', 1)[0];
    const storefrontMailbox = route === storefrontMailboxQueryRoute &&
      mailboxPublicUrl && request.headers.host === mailboxPublicUrl.host;
    if (!storefrontMailbox && !allowsHost(request.headers.host, address.port)) {
      response.writeHead(403).end();
      return;
    }
    if (route === readyPath && handleReadiness) return handleReadiness(request, response);
    if (route === monitorReportPath && handleProbeReport) return void handleProbeReport(request, response);
    if (vendureRehearsal && route.startsWith(vendureRechargePrefix + '/'))
      return void vendureRehearsal.handle(request, response);
    if (handleLegacyToolRoute && [legacyMicrosoftMailboxCallback, legacyWebsiteVisitIngest].includes(route)) {
      return void handleLegacyToolRoute(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
    }
    if (loadAuth && !auth) {
      try {
        auth = loadAuth();
      } catch {
        response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        return response.end('本机账号配置读取失败，请检查运行目录。');
      }
    }
    const actor = auth?.getActor(request);
    if (monitoringSources && (route.startsWith('/api/') || route.startsWith('/integrations/codexdaichong/api/')))
      response.once('finish', () => monitoringSources.recordHttp(route, response.statusCode, actor));
    if (request.localAuthUnavailable) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '5' });
      return response.end(JSON.stringify({ error: '登录服务暂时不可用，请稍后重试，登录信息未清除' }));
    }
    if (route === storefrontMailboxQueryRoute) {
      if (!storefrontMailbox || !auth || request.url !== storefrontMailboxQueryRoute) {
        response.writeHead(storefrontMailbox ? 400 : 404, { 'Cache-Control': 'private, no-store' }).end();
        return;
      }
      return void handleManagedMailboxQuery(request, response);
    }
    const loginRequired = Boolean(publicUrl || auth || setupAdmin);
    const canManage = !loginRequired || ['admin', 'super'].includes(actor?.role);
    const forbidden = () => {
      const code = actor ? 403 : 401;
      response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      return response.end(JSON.stringify({ error: actor ? '当前账号无权执行此操作' : '登录已过期或已失效，请重新登录',
        ...(!actor ? { reason: request.localAuthReason || 'invalid' } : {}) }));
    };
    if (dataChanges && route === dataChangeRoute) {
      if (loginRequired && !actor) return forbidden();
      const origin = secureOrigin || `http://${request.headers.host}`;
      if ((request.headers.origin && request.headers.origin !== origin) ||
          (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])))
        return response.writeHead(403).end();
      return dataChanges.handle(request, response, actor || { id: 'local-operator', role: 'admin' });
    }
    if (store && route.startsWith('/api/local/auth/')) {
      if (publicUrl && route === '/api/local/auth/setup') return response.writeHead(404).end();
      if (route === '/api/local/auth/setup' && setupAdmin) {
        if (!auth) return void setupAdmin.handle(request, response);
        response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        return response.end(JSON.stringify({ error: '本机管理员已设置，请直接登录' }));
      }
      if (auth) return void auth.handle(request, response);
      if (route === '/api/local/auth/session' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return response.end(JSON.stringify({ configured: false, actor: null }));
      }
      return response.writeHead(503).end();
    }
    if (store && route.startsWith(microsoftMailboxPrefix)) {
      const operation = route.slice(microsoftMailboxPrefix.length);
      if (operation !== 'callback' && (!actor || !canManage)) return forbidden();
      return void microsoftMailbox.handle(request, response, operation, actor);
    }
    if (store && route === managedMailboxQueryRoute) {
      if (!auth) return forbidden();
      return void handleManagedMailboxQuery(request, response);
    }
    if (store && route === '/api/local/apple-relay/public-query') {
      if (!auth) {
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        return response.end(JSON.stringify({ success: false, error: '邮箱查询服务尚未启用' }));
      }
      return void relay.handlePublicQuery(request, response);
    }
    if (store && route.startsWith('/api/local/apple-relay/')) {
      if (!canManage || (!auth && relayConfig)) return forbidden();
      return void relay.handle(request, response, route, actor);
    }
    if (store && route === financeCollectionRoute) {
      if (!canManage || (loginRequired && !actor)) return forbidden();
      return void handleFinanceCollection(request, response, actor || { id: 'local-operator', name: '本机操作员', role: 'admin' });
    }
    if (store && route === orderExpenseRoute) {
      if (!canManage || (loginRequired && !actor)) return forbidden();
      return void handleOrderExpense(request, response, actor || { id: 'local-operator', name: '本机操作员', role: 'admin' });
    }
    if (route === monitorPath && handleMonitoring) return void handleMonitoring(request, response, actor);
    if (store && route === automaticSnapshotRoute) {
      if (!canManage) return forbidden();
      return void handleAutomaticSnapshot(request, response, actor);
    }
    if (store && route === rechargeCodesRoute) {
      if (!actor) return forbidden();
      return void handleRechargeCodes(request, response, actor);
    }
    if (rechargeActivity && (route === rechargeActivityRoute || route.startsWith(rechargeActivityRoute + '/'))) {
      if (!actor) return forbidden();
      return void rechargeActivity.handle(request, response, actor);
    }
    if (store && route === orderSyncRoute) {
      if (!actor || !canManage) return forbidden();
      return void orderSync.handle(request, response, actor);
    }
    if (store && orderAuxiliaryRoutes.has(route)) {
      if (!actor || !canManage) return forbidden();
      return void handleOrderAuxiliary(request, response, route, actor);
    }
    if (store && cardManagementRoutes.has(route)) {
      response.setHeader('Cache-Control', 'private, no-store');
      if (!actor || !canManage) return forbidden();
      return void handleCardManagement(request, response, route, actor);
    }
    if (store && claudeGoogleSubscriptionRoutes.has(route)) {
      response.setHeader('Cache-Control', 'private, no-store');
      if (!actor || !canManage) return forbidden();
      return void handleClaudeGoogleSubscriptions(request, response, route, actor);
    }
    if (store && subscriptionRoutes.has(route)) {
      response.setHeader('Cache-Control', 'private, no-store');
      if (!actor || !canManage) return forbidden();
      return void handleSubscriptions(request, response, route, actor);
    }
    if (store && route === employeeStatisticsRoute)
      return void handleEmployeeStatistics(request, response, actor);
    if (store && route.startsWith('/api/local/tools/media/')) {
      if (!actor) return forbidden();
      return void handleMediaResolver(request, response, actor);
    }
    if (store && route.startsWith('/api/local/tools/website-visits/')) {
      const operation = route.slice('/api/local/tools/website-visits/'.length);
      if (operation !== 'ingest' && (!actor || !canManage)) return forbidden();
      return void handleWebsiteVisits(request, response, operation, actor);
    }
    if (store && route === '/api/local/tools/website-analytics') {
      if (!actor || !canManage) return forbidden();
      return void handleWebsiteAnalytics(request, response);
    }
    if (store && route === sheetsStatusRoute) return void handleSheetsStatus(request, response, actor);
    if (store && route === '/api/local/tools/website-monitor') {
      if (!actor) return forbidden();
      return void monitorWebsite(request, response, actor);
    }
    if (store && route === '/api/local/bitbrowser-proxies/extract') {
      if (!actor || !canManage) return forbidden();
      return void extractBitProxy(request, response, actor);
    }
    if (store && route.startsWith('/api/local/')) {
      if (loginRequired && !actor) return forbidden();
      if (
        !canManage &&
        route !== '/api/local/toolbox' &&
        route !== localBusiness.columnPreferencesRoute &&
        route !== '/api/local/order-completion' &&
        !['/api/local/saved-totp', '/api/local/saved-totp/code', '/api/local/saved-totp/secret'].includes(route) &&
        (request.method !== 'GET' || !['inventory', 'commerce'].includes(route.split('/').at(-1)))
      )
        return forbidden();
      return void localBusiness.handleLocalBusiness(request, response, route, store, actor, {
        publicOrigin: secureOrigin,
        readOrderCards: () => readPoolCards(orderRechargeClient, { includeNumbers: true }),
        readOrderOwners: () => auth?.orderOwners() || [],
        verifyManagedMailbox: readManagedMailbox || verifyMailboxImap,
        async verifyRelayExtraction(aliasIds, operator) {
          const { items } = await relay.checkExtractionEligibility(aliasIds, operator);
          return items.filter((item) => item.eligible).map((item) => item.id);
        }
      });
    }

    if (route === '/integrations/bitbrowser/local-login') {
      if (!canManage) return forbidden();
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      }
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': localBitCheck.length,
        'Content-Security-Policy':
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
      });
      return response.end(request.method === 'HEAD' ? undefined : localBitCheck);
    }
    if (route.startsWith('/integrations/codexdaichong/')) {
      if (!canManage || (rechargeConfig && !actor)) return forbidden();
      const gateway = gatewayFor(request.headers.host);
      if (gateway) return gateway.handle(request, response);
      if (route === '/integrations/codexdaichong/status' && request.method === 'GET') {
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        return response.end(JSON.stringify({ ready: false, message: '充值服务未接入' }));
      }
      return response.writeHead(404).end();
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const path = route;
    if (publicUrl && path === '/login') {
      response.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' }).end();
      return;
    }
    if (path === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    if (publicUrl && path === '/design-preview.html') return response.writeHead(404).end();
    const asset = assets.get(
      path === '/' || path === '/design-preview.html' ? '/index.html' : path
    );
    if (!asset) {
      response.writeHead(404).end();
      return;
    }
    if (asset.publicMetadata) return sendPublicAsset(request, response, asset);
    if (path === '/mailbox-query') {
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      );
    }
    let body = asset.body;
    if (store && asset === assets.get('/index.html')) {
      let metadata = '<head>\n<meta name="id-local-data-events" content="enabled" />';
      if (!loginRequired || actor) {
        response.setHeader('Cache-Control', 'private, no-store');
        let preferences = '';
        try {
          preferences = encodeURIComponent(JSON.stringify(store.loadColumnPreferences(actor)));
        } catch { /* Leave the page usable and let it report that preferences could not be read. */ }
        metadata += `\n<meta name="id-column-preferences" content="${preferences}" />`;
      }
      body = Buffer.from(body.toString('utf8').replace('<head>', metadata));
    }
    if (loginRequired && signedOutIndex && asset === assets.get('/index.html')) {
      if (!actor) response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      body = actor
        ? Buffer.from(
            body
              .toString('utf8')
              .replace(
                '<head>',
                `<head>\n    <meta name="id-local-auth" content="required" />\n    <meta name="id-local-actor" content="${encodeURIComponent(JSON.stringify(actor))}" />`
              )
          )
        : setupIndex && !auth ? setupIndex : signedOutIndex;
    }
    response.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': body.length });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  if (financeCollection) server.once('close', () => financeCollection.close());
  if (systemMonitoring) server.once('close', () => { monitoringSources?.close(); systemMonitoring.close(); });
  if (rechargeActivity) server.once('close', () => rechargeActivity.close());
  if (rechargeEvents) server.once('close', () => rechargeEvents.close());
  if (store) server.once('close', () => { relay?.close(); handleManagedMailboxQuery?.close(); store.close(); });
  if (dataChanges) server.once('close', () => dataChanges.close());
  if (rechargeOrderSync && orderSync && rechargeConfig && !rechargeEvents) {
    const syncOrders = () => void orderSync.run({ apply: true }).catch(() => {});
    const timer = setInterval(syncOrders, 60_000);
    timer.unref();
    server.once('listening', syncOrders);
    server.once('close', () => clearInterval(timer));
  }
  if (codexdaichong || rechargeConfig) {
    server.on('upgrade', (request, socket, head) => {
      const address = server.address();
      if (
        !allowsHost(request.headers.host, address.port) ||
        request.url !== '/integrations/codexdaichong/socket' ||
        ((auth || rechargeConfig) && !['admin', 'super'].includes(auth?.getActor(request)?.role))
      ) {
        socket.destroy();
        return;
      }
      gatewayFor(request.headers.host).upgrade(request, socket, head);
    });
  }
  let storefrontAdmission;
  if (storefrontAdmissionDirectory) {
    try {
      storefrontAdmission = await listenStorefrontAdmission(storefrontAdmissionDirectory, (code, ip) =>
        orderRechargeClient.verifyStorefrontCode(code, ip));
      server.once('close', () => storefrontAdmission.close());
    } catch (error) {
      financeCollection?.close();
      store?.close();
      throw error;
    }
  }
  await new Promise((resolve, reject) => {
    const startFailed = (error) => {
      storefrontAdmission?.close();
      financeCollection?.close();
      store?.close();
      reject(error);
    };
    server.once('error', startFailed);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', startFailed);
      resolve();
    });
  });
  financeCollection?.start();
  monitoringSources?.start();
  if (rechargeEvents) rechargeEvents.start();
  else rechargeActivity?.start();
  return { server, url: 'http://127.0.0.1:' + server.address().port + '/' };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const { values } = parseArgs({
      allowNegative: true,
      options: {
        'local-data': { type: 'boolean' },
        'public-origin': { type: 'string' },
        'data-dir': { type: 'string' },
        port: { type: 'string' },
        'finance-provider': { type: 'string' },
        'media-resolver-url': { type: 'string' },
        'website-analytics-config': { type: 'string' },
        'website-cloudflare-config': { type: 'string' },
        'website-visits-secret-file': { type: 'string' },
        'microsoft-mailbox-config': { type: 'string' },
        'mailbox-public-origin': { type: 'string' },
        'codexdaichong-url': { type: 'string' },
        'recharge-order-sync': { type: 'boolean' }
      }
    });
    const port = values.port === undefined ? 4347 : Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效');
    const publicOrigin = values['public-origin'];
    if (Boolean(publicOrigin) !== Boolean(values['data-dir']) || (publicOrigin && values['local-data']))
      throw new Error('正式站需要同时指定 HTTPS 地址和正式数据目录。');
    if (publicOrigin) process.umask(0o077);
    const { databasePath, authPath, relayPath } = publicOrigin
      ? await productionDataPaths(values['data-dir'])
      : values['local-data'] ? {
          databasePath: fileURLToPath(new URL('../.runtime/local-business.sqlite', import.meta.url)),
          authPath: fileURLToPath(new URL('../.runtime/local-auth.json', import.meta.url)),
          relayPath: fileURLToPath(new URL('../.runtime/local-apple-relay.json', import.meta.url))
        } : {};
    const relayConfig = databasePath
      ? await (
          await import('./apple-relay/local-service.mjs')
        ).loadAppleRelayConfig(relayPath)
      : undefined;
    const rechargeConfig = values['codexdaichong-url']
      ? { upstreamUrl: values['codexdaichong-url'], secret: process.env.ID_RECHARGE_BRIDGE_SECRET }
      : undefined;
    const [websiteAnalyticsConfig, websiteCloudflareConfig, websiteVisitsSecret, microsoftMailboxConfig] = await Promise.all(
      [
        readToolConfig(values['website-analytics-config'], 'website-analytics'),
        readToolConfig(values['website-cloudflare-config'], 'website-cloudflare'),
        readToolConfig(values['website-visits-secret-file'], 'website-visits'),
        readToolConfig(values['microsoft-mailbox-config'], 'microsoft-mailbox')
      ]
    );
    const { url } = await startPreview(port, {
      databasePath,
      authPath,
      publicOrigin,
      relayConfig,
      rechargeConfig,
      rechargeOrderSync: values['recharge-order-sync'],
      financeProvider: values['finance-provider'],
      mediaResolverUrl: values['media-resolver-url'],
      websiteAnalyticsConfig,
      websiteCloudflareConfig,
      websiteVisitsSecret,
      mailboxPublicOrigin: values['mailbox-public-origin'],
      microsoftMailboxConfig
    });
    console.log(
      (publicOrigin ? 'ID 业务管理系统 · 正式站内网监听：' :
        databasePath ? 'ID 业务管理系统 · 本机业务模式：' : 'ID 业务管理系统 · 独立新版设计预览：') +
        url
    );
    console.log(databasePath ? '本机数据存储已启用。' : '此入口使用虚构演示资料。');
  } catch (error) {
    console.error('独立预览启动失败：' + error.message);
    process.exitCode = 1;
  }
}
