import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
import { createCustomerQueryHandler, customerQueryRoutes } from './customer-query.mjs';
import { createRechargeCodeHandler, rechargeCodesRoute } from './recharge-code-requests.mjs';
import { createRechargeOrderSync, orderSyncRoute } from './recharge-order-sync.mjs';
import { createRechargeActivity, rechargeActivityDomain, rechargeActivityRoute } from './recharge-activity.mjs';
import { createDataChangeStream, dataChangeRoute, dataSourceIdentity } from './change-sync.mjs';
import { createEmployeeStatisticsHandler, employeeStatisticsRoute } from './employee-statistics.mjs';
import { monitorPath, monitorConfigDomain, monitorReportPath, readyPath } from './monitoring-policy.mjs';
import { createSystemMonitoring } from './system-monitoring.mjs';
import { createMonitoringSources } from './monitoring-sources.mjs';
import { createMonitoringHandler, createMonitoringReadiness, createProbeReportHandler } from './monitoring-route.mjs';
import { createLegacyRechargeNotifications } from './monitoring-recharge.mjs';
import { probeCodexdaichongRuntime } from '../modules/recharge/codexdaichong/runtime-health.mjs';
import { createRechargeEvents } from './recharge-events.mjs';
import { createSiteObservations, measuredActivity } from './site-observations.mjs';
import { createSiteManagement, siteManagementPath, siteObservationScope, siteReleaseInfo, siteBackupView } from './site-management.mjs';
import { loadLoginSecurity, turnstileLoginPage, verifiedAddress } from './login-security.mjs';
import { managesBusiness, nativeBrowserVerification, nativeManagerAccess, retailAccess } from './access-roles.mjs';
import { createStaffWorkspaces, staffPath } from './staff-workspaces.mjs';
import { createRenewalHandoff, renewalHandoffPath } from './renewal-handoff.mjs';
import { readBackupMonitorReceipt, readRestoreEvidence } from './monitoring-worker-receipts.mjs';

function requireSecurityConfirmation(response) {
  response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  return response.end(JSON.stringify({ error: '请先完成安全确认，再继续这项操作', code: 'SECURITY_CONFIRMATION_REQUIRED' }));
}

const publicAssetTypes = new Set(['text/css; charset=utf-8', 'text/javascript; charset=utf-8', 'image/png']);

const files = new Map([
  ['index.html', 'text/html; charset=utf-8'],
  ['brand/ai-subscription-mark.png', 'image/png'],
  ['brand/favicon-32.png', 'image/png'],
  ['brand/apple-touch-icon.png', 'image/png'],
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
  ['site-management.css', 'text/css; charset=utf-8'],
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
    'mailbox-delivery',
    'customer-query',
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
    'site-timing',
    'account-security',
    'staff-workspaces',
    'renewal-handoff',
    'site-management',
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
  const [parameter, weight, extra] = quality.split('=');
  if (parameter.trim() !== 'q' || weight === undefined || extra !== undefined) return false;
  const match = /^(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.exec(weight.trim());
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
  const securityPath = publicUrl && authPath ? authPath + '.security.json' : undefined;
  const securityFile = securityPath && await lstat(securityPath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const storedSecurity = securityFile ? await readToolConfig(securityPath, 'login-security') : undefined;
  const loginSecurity = authPath ? loadLoginSecurity({ ...process.env, ...storedSecurity }, publicUrl) : {};
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
  let store = null, dataSource;
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
  let handleEmployeeStatistics, handleCustomerQuery;
  let handleStaffWorkspaces, handleRenewalHandoff;
  let systemMonitoring, monitoringSources, handleMonitoring, handleProbeReport, handleReadiness, siteObservations, handleSiteManagement;
  const orderRechargeClient = createOrderRechargeClient(rechargeConfig);
  const gateways = new Map();
  const cardPlanEpoch = Date.now().toString(36);
  let cardPlanVersion = 0;
  let nativeCardPlanVersion = -1;
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
            if (version <= nativeCardPlanVersion) return;
            nativeCardPlanVersion = version;
            cardPlanVersion++;
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
        if (publicUrl && !loginSecurity.mfaKey)
          loginSecurity.mfaKey = () => store.loginAuthenticatorKey();
        const { createLocalAuth, createLocalAdminSetup, localAdminEmail } = await import('./local-auth.mjs');
        loadAuth = () => createLocalAuth(authPath, {
          onEvent: (event) => store.recordAuthEvent(event),
          onMonitoring: publicUrl ? (event) => queueMicrotask(() => monitoringSources?.recordAuth(event)) : undefined,
          publicUrl, security: loginSecurity
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
      dataSource = await dataSourceIdentity(databasePath);
      const release = siteReleaseInfo(publicUrl ? await readFile(new URL('./.website-version.json', import.meta.url), 'utf8')
        .then(JSON.parse).catch(() => null) : null);
      siteObservations = await createSiteObservations({
        path: publicUrl ? join(dirname(databasePath), 'site-observations.json') : undefined, version: release.version
      });
      handleSiteManagement = createSiteManagement({ store, observations: siteObservations, origin: secureOrigin, release,
        official: Boolean(publicUrl), readBackups: () => readBackupMonitorReceipt(monitoringBackupReceiptsDirectory),
        readRecoveries: () => readRestoreEvidence(monitoringBackupReceiptsDirectory),
        authorizeBusinessExport: request => auth?.recentlyVerified(request),
        readSources: () => monitoringSources?.adminView() || { sources: [], externalProbe: null }
      });
      if (rechargeConfig) rechargeActivity = createRechargeActivity({
        store, client: orderRechargeClient, publicOrigin: secureOrigin, getActor: request => auth?.getActor(request)
      });
      systemMonitoring = createSystemMonitoring({ store, origin: secureOrigin,
        native: rechargeConfig ? createLegacyRechargeNotifications(orderRechargeClient) : undefined,
        send: publicUrl ? undefined : async () => ({ status: 'failed', reason: 'configuration' }) });
      const confirmProtectedAction = request => !auth?.shouldVerify() || auth.recentlyVerified(request);
      handleMonitoring = createMonitoringHandler({ monitor: systemMonitoring, publicOrigin: secureOrigin,
        confirmSettings: confirmProtectedAction });
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
          async onResourceSample(available, report) {
            const recoveries = await readRestoreEvidence(monitoringBackupReceiptsDirectory);
            const { collector, databases } = siteBackupView(report, recoveries);
            await siteObservations.collect(available, { collector, databases });
          },
          readOrderPending: () => orderSync?.healthView(),
          syncEnabled: Boolean(rechargeConfig && rechargeOrderSync), syncViaEvents: Boolean(rechargeEventsConfig) });
      }
      handleOrderAuxiliary = createOrderAuxiliaryHandler({ store, client: orderRechargeClient, publicOrigin: secureOrigin });
      handleCardManagement = createCardManagementHandler({ store, client: orderRechargeClient, publicOrigin: secureOrigin,
        authorizeSensitive: confirmProtectedAction });
      handleClaudeGoogleSubscriptions = createClaudeGoogleSubscriptionsHandler({ store, publicOrigin: secureOrigin });
      handleSubscriptions = createSubscriptionHandler({ store, publicOrigin: secureOrigin,
        readOwners: () => auth?.orderOwners() || [] });
      handleCustomerQuery = createCustomerQueryHandler({ store, publicOrigin: secureOrigin });
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
        readSource: request => verifiedAddress(request, loginSecurity),
        readMailbox: microsoftMailbox.readMailbox, watchMailbox: microsoftMailbox.watchMailbox
      });
      if (publicUrl) handleLegacyToolRoute = createLegacyToolRoutes({
        publicOrigin: secureOrigin, microsoftMailbox, handleWebsiteVisits
      });
      const { createAppleRelayService } = await import('./apple-relay/local-service.mjs');
      relay = createAppleRelayService({
        config: relayConfig,
        publicOrigin: secureOrigin,
        readSource: request => verifiedAddress(request, loginSecurity),
        readInventory: () => store.load('inventory').data,
        deliveryJournal: store.relayDeliveryJournal,
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
      handleStaffWorkspaces = createStaffWorkspaces({ store, client: orderRechargeClient, publicOrigin: secureOrigin,
        getAuth: () => auth, readMailbox: microsoftMailbox.readMailbox, readRelayCodes: relay.registrationCodes,
        cardChanged: () => { cardPlanVersion++; store.notifyChanges(); } });
      handleRenewalHandoff = createRenewalHandoff({ store, client: orderRechargeClient, publicOrigin: secureOrigin,
        getAuth: () => auth });
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
        '    <link rel="stylesheet" href="/local-auth.css?v=site-foundation" />\n' +
          '    <script src="/local-data.js" defer></script>\n' +
          '    <script src="/toolbox-local.js" defer></script>\n' +
          '    <script src="/local-auth.js?v=site-foundation" defer></script>\n    <script src="./prototype.js'
      )
      .replace('20261105-bit-login" />', '20261106-local-inventory-settings" />')
      .replace(
        '<title>AI订阅管理系统 · 设计预览</title>',
        publicUrl ? '<title>AI订阅管理系统</title>' : '<title>AI订阅管理系统 · 独立本机测试</title>'
      )
      .replace('页面设计预览 · 所有资料均为虚构示例', publicUrl ? '内部工作台' : '本机业务模式 · 未接入的模块仍为演示');
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
      store?.close();
      throw error;
    }
    if (loadAuth) {
      signedOutIndex = Buffer.from(
        turnstileLoginPage(localIndex, loginSecurity.siteKey)
          .replace('<head>', '<head>\n    <meta name="id-local-auth" content="required" />' +
            (publicUrl ? '\n    <meta name="id-site-observations" content="enabled" />' : ''))
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
  function dataChangeVersions(actor) {
    const versions = { ...store.changeVersions(actor), operators: auth?.changeVersion() || '0',
      ...(rechargeActivity && { [rechargeActivityDomain]: rechargeActivity.version(actor) }) };
    for (const [scope, revision] of Object.entries(rechargeEvents?.versions() || {}))
      if (Object.hasOwn(versions, scope)) versions[scope] += ':' + revision;
    if (systemMonitoring && Object.hasOwn(versions, 'system-monitoring'))
      versions['system-monitoring'] += ':' + systemMonitoring.changeVersion();
    if (siteObservations && ['admin', 'super'].includes(actor.role)) {
      versions[siteObservationScope] = siteObservations.versionOf();
      versions['site-resources'] = siteObservations.resourceVersionOf();
      versions['site-backups'] = siteObservations.backupVersionOf();
    }
    if (rechargeConfig && ['finance', 'super'].includes(actor.role))
      versions['recharge-card-plans'] = [cardPlanEpoch, cardPlanVersion, versions['recharge-card-plans']].join(':');
    return versions;
  }
  const dataChanges = store ? createDataChangeStream({
    source: dataSource,
    getActor: request => auth?.getActor(request, { throwOnUnavailable: true }) || (!authPath && !publicUrl
      ? { id: 'local-operator', role: 'admin' } : null),
    getVersions: dataChangeVersions,
    subscribe: listener => {
      const stopStore = store.subscribeChanges(listener);
      const stopSamples = systemMonitoring?.subscribeChanges(listener);
      const stopSite = siteObservations?.subscribe(listener);
      return () => { stopStore(); stopSamples?.(); stopSite?.(); };
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
    if (publicUrl) {
      response.setHeader('Strict-Transport-Security', 'max-age=31536000');
      response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    }
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
    if (publicUrl && siteObservations && (request.headers.origin === secureOrigin || !request.headers.origin) &&
        !['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) {
      const activity = measuredActivity(route, request.method, request.headers['x-id-measured-action']);
      if (actor || activity === 'login') siteObservations.request(response, activity, actor?.id);
    }
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
    const canManage = !loginRequired || managesBusiness(actor);
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
    const requestSource = request.headers['x-id-data-source'];
    if (store && route.startsWith('/api/local/') && requestSource && requestSource !== dataSource &&
        !['GET', 'HEAD'].includes(request.method) && (!loginRequired || actor)) {
      response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      return response.end(JSON.stringify({ code: 'DATA_SOURCE_CHANGED', error: '业务数据来源已变化，请重新加载页面后核对' }));
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
    const scopedRole = actor && !canManage;
    const readable = request.method === 'GET' || request.method === 'HEAD';
    if (route === renewalHandoffPath && handleRenewalHandoff) return void handleRenewalHandoff(request, response, actor);
    const publicQuery = [managedMailboxQueryRoute, '/api/local/apple-relay/public-query'].includes(route);
    if (scopedRole && route.startsWith('/api/local/') && !publicQuery && route !== siteManagementPath + '/timing' &&
        route !== localBusiness?.columnPreferencesRoute && !retailAccess(actor, route, request.method))
      return forbidden();
    if (store && route.startsWith(staffPath)) {
      if (!actor) return forbidden();
      return void handleStaffWorkspaces(request, response, route, actor);
    }
    if (store && route.startsWith(microsoftMailboxPrefix)) {
      const operation = route.slice(microsoftMailboxPrefix.length);
      if (operation !== 'callback' && (!actor || !canManage)) return forbidden();
      return void microsoftMailbox.handle(request, response, operation, actor);
    }
    if (store && route === managedMailboxQueryRoute) {
      if (!auth) return forbidden();
      return void handleManagedMailboxQuery(request, response, actor);
    }
    if (store && route === '/api/local/apple-relay/public-query') {
      if (!auth) {
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        return response.end(JSON.stringify({ success: false, error: '邮箱查询服务尚未启用' }));
      }
      return void relay.handlePublicQuery(request, response);
    }
    if (store && route.startsWith('/api/local/apple-relay/')) {
      if ((!canManage && !(actor?.role === 'registrar' && route === '/api/local/apple-relay/alias-register')) ||
          (!auth && relayConfig)) return forbidden();
      return void relay.handle(request, response, route, actor);
    }
    if (store && route === financeCollectionRoute) {
      if (!canManage || (loginRequired && !actor) || (actor?.role === 'admin' && (!readable ||
          ['settings', 'settings-history'].includes(new URL(request.url, 'http://localhost').searchParams.get('tab')))))
        return forbidden();
      if (actor?.role === 'super' && !readable && auth.shouldVerify() && !auth.recentlyVerified(request))
        return requireSecurityConfirmation(response);
      return void handleFinanceCollection(request, response, actor || { id: 'local-operator', name: '本机操作员', role: 'admin' });
    }
    if (store && route === orderExpenseRoute) {
      if ((!canManage && !(actor?.role === 'finance' && readable)) || (loginRequired && !actor)) return forbidden();
      return void handleOrderExpense(request, response, actor || { id: 'local-operator', name: '本机操作员', role: 'admin' });
    }
    if (handleSiteManagement && (route === siteManagementPath || route.startsWith(siteManagementPath + '/')))
      return void handleSiteManagement(request, response, actor);
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
      if (readable && auth.shouldVerify() && !auth.recentlyVerified(request) &&
          route === '/api/local/subscription-card-status' &&
          new URL(request.url, 'http://localhost').searchParams.get('includeDetails') === '1')
        return requireSecurityConfirmation(response);
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
    if (store && customerQueryRoutes.has(route)) {
      if (!actor || !canManage) return forbidden();
      return void handleCustomerQuery(request, response, route, actor);
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
      return void localBusiness.handleLocalBusiness(request, response, route, store, actor, {
        publicOrigin: secureOrigin,
        authorizeSensitive: auth?.shouldVerify() ? request => auth.recentlyVerified(request) : undefined,
        isRegistrar: auth?.isRegistrar,
        requireRenewalHandoff: Boolean(handleRenewalHandoff && auth),
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
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
      });
      return response.end(request.method === 'HEAD' ? undefined : localBitCheck);
    }
    if (route.startsWith('/integrations/codexdaichong/')) {
      if (!canManage || (rechargeConfig && !actor)) return forbidden();
      const nativeRoute = route.slice('/integrations/codexdaichong'.length);
      if (!nativeManagerAccess(actor, nativeRoute, request.method)) return forbidden();
      if (auth?.shouldVerify() && nativeBrowserVerification(nativeRoute, request.method) && !auth.recentlyVerified(request))
        return requireSecurityConfirmation(response);
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
    if (publicUrl && path === '/design-preview.html') return response.writeHead(404).end();
    const asset = assets.get(
      path === '/favicon.ico' ? '/brand/favicon-32.png' :
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
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      );
    }
    let body = asset.body;
    if (store && asset === assets.get('/index.html')) {
      let metadata = '<head>\n<meta name="id-local-data-events" content="enabled" />';
      if (publicUrl) metadata += '\n<meta name="id-site-observations" content="enabled" />';
      if (!loginRequired || actor) {
        metadata += `\n<meta name="id-data-source" content="${dataSource}" />`;
        response.setHeader('Cache-Control', 'private, no-store');
        try {
          const versions = dataChangeVersions(actor || { id: 'local-operator', role: 'admin' });
          metadata += `\n<meta name="id-data-versions" content="${encodeURIComponent(JSON.stringify(versions))}" />`;
        } catch { /* The event stream can still establish versions when the store becomes available. */ }
        let preferences = '';
        try {
          preferences = encodeURIComponent(JSON.stringify(store.loadColumnPreferences(actor)));
        } catch { /* Leave the page usable and let it report that preferences could not be read. */ }
        metadata += `\n<meta name="id-column-preferences" content="${preferences}" />`;
      }
      body = Buffer.from(body.toString('utf8').replace('<head>', metadata));
    }
    if (loginRequired && signedOutIndex && asset === assets.get('/index.html')) {
      response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
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
  if (siteObservations && !monitoringSources) {
    const collect = () => void siteObservations.collect().catch(() => {});
    const timer = setInterval(collect, 60_000);
    timer.unref();
    server.once('close', () => clearInterval(timer));
  }
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
      (publicOrigin ? 'AI订阅管理系统 · 正式站内网监听：' :
        databasePath ? 'AI订阅管理系统 · 本机业务模式：' : 'AI订阅管理系统 · 独立新版设计预览：') +
        url
    );
    console.log(databasePath ? '本机数据存储已启用。' : '此入口使用虚构演示资料。');
  } catch (error) {
    console.error('独立预览启动失败：' + error.message);
    process.exitCode = 1;
  }
}
