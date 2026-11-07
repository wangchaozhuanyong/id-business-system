import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { installFinanceAssets } from './finance/preview-assets.mjs';
import { createFinanceQuoteService } from './finance/quote-service.mjs';
import { createFinanceCollection } from './finance/collection-service.mjs';
import { financeCollectionRoute, createFinanceCollectionHandler } from './finance/collection-route.mjs';
import { automaticSnapshotRoute, createAutomaticSnapshotHandler } from './finance/quote-route.mjs';
import { createWebsiteMonitor, handleWebsiteMonitor } from './tools/website-monitor.mjs';
import { createBitBrowserProxyExtraction } from './bitbrowser-proxy-extraction.mjs';
import { createWebsiteAnalytics } from './tools/website-analytics.mjs';
import { createWebsiteVisits } from './tools/website-visits.mjs';
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
import { productionDataPaths } from './production-data.mjs';
import { createOrderRechargeClient, readPoolCards } from './order-recharge-client.mjs';
import { createOrderAuxiliaryHandler, orderAuxiliaryRoutes } from './order-auxiliary.mjs';
import { createRechargeCodeHandler, rechargeCodesRoute } from './recharge-code-requests.mjs';
import { createRechargeOrderSync, orderSyncRoute } from './recharge-order-sync.mjs';
import { createDataChangeStream, dataChangeRoute } from './change-sync.mjs';

const files = new Map([
  ['index.html', 'text/html; charset=utf-8'],
  ['prototype.css', 'text/css; charset=utf-8'],
  ['title-help.css', 'text/css; charset=utf-8'],
  ['overview-prototype.css', 'text/css; charset=utf-8'],
  ['finance-collection.css', 'text/css; charset=utf-8'],
  ['recharge-integration.css', 'text/css; charset=utf-8'],
  ['bitbrowser-addresses.css', 'text/css; charset=utf-8'],
  ...[
    'prototype',
    'overview-prototype',
    'finance-collection',
    'title-help',
    'inventory-prototype',
    'apple-relay-prototype',
    'apple-balance-prototype',
    'commerce-prototype',
    'order-operations',
    'change-sync',
    'operations-prototype',
    'bitbrowser-addresses'
  ].map((name) => [name + '.js', 'text/javascript; charset=utf-8'])
]);

export async function startPreview(
  port = 4347,
  {
    codexdaichong,
    rechargeConfig,
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
    websiteAnalyticsFetch,
    websiteVisitsSecret,
    readManagedMailbox,
    mailboxPublicOrigin,
    microsoftMailboxConfig,
    microsoftMailboxFetch,
    rechargeOrderSync = false
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
    fetchImpl: websiteAnalyticsFetch
  });
  const extractBitProxy = createBitBrowserProxyExtraction({ publicOrigin: secureOrigin });
  const monitorWebsite = publicUrl ? createWebsiteMonitor({ publicOrigin: secureOrigin }) : handleWebsiteMonitor;
  const assets = new Map(
    await Promise.all(
      [...files].map(async ([file, type]) => [
        '/' + file,
        { type, body: await readFile(new URL('../frontend/' + file, import.meta.url)) }
      ])
    )
  );
  const localBitAssets = [
    ['/assets/bitbrowser/authorization.mjs', '../modules/recharge/bitbrowser/authorization.mjs'],
    ['/assets/bitbrowser/catalog.mjs', '../modules/recharge/bitbrowser/catalog.mjs'],
    ...['countries', 'proxy-input', 'proxy-test', 'proxy-extraction'].map(name => [`/assets/bitbrowser/${name}.mjs`, `../modules/recharge/bitbrowser/${name}.mjs`]),
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
  let financeCollection = null, handleFinanceCollection = null;
  let handleOrderAuxiliary, handleRechargeCodes, orderSync;
  const orderRechargeClient = createOrderRechargeClient(rechargeConfig);
  const gateways = new Map();
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
          onEvent: (event) => store.recordAuthEvent(event), publicUrl
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
      handleOrderAuxiliary = createOrderAuxiliaryHandler({ store, client: orderRechargeClient, publicOrigin: secureOrigin });
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
        store, publicOrigin: secureOrigin, storefrontOrigin: mailboxPublicUrl?.origin, readMailbox: microsoftMailbox.readMailbox
      });
      if (publicUrl) handleLegacyToolRoute = createLegacyToolRoutes({
        publicOrigin: secureOrigin, microsoftMailbox, handleWebsiteVisits
      });
      const { createAppleRelayService } = await import('./apple-relay/local-service.mjs');
      relay = createAppleRelayService({
        config: relayConfig,
        publicOrigin: secureOrigin,
        readInventory: () => store.load('inventory').data,
        savePrimaries: (rows, actor, aliases, registration) =>
          store.saveAppleRelayPrimaries(rows, actor, aliases, registration),
        fetchImpl: relayFetch,
        recordAction: ({ action, actor, parentId, aliasId }) =>
          store.recordAuthEvent({ action: 'relay_' + action, actor, targetId: aliasId || parentId })
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
      const quoteService = createFinanceQuoteService({
        provider: financeProvider,
        fetchQuote: financeFetch, collection: financeCollection
      });
      handleAutomaticSnapshot = createAutomaticSnapshotHandler({ store, quoteService, publicOrigin: secureOrigin });
      orderSync = createRechargeOrderSync({ store, client: orderRechargeClient, quoteService, publicOrigin: secureOrigin });
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
    getActor: request => auth?.getActor(request) || (!authPath && !publicUrl
      ? { id: 'local-operator', role: 'admin' } : null),
    getVersions: actor => ({ ...store.changeVersions(actor), operators: auth?.changeVersion() || '0' }),
    subscribe: listener => store.subscribeChanges(listener),
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
      return response.end(JSON.stringify({ error: actor ? '当前账号无权执行此操作' : '请先登录' }));
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
    if (store && route === automaticSnapshotRoute) {
      if (!canManage) return forbidden();
      return void handleAutomaticSnapshot(request, response, actor);
    }
    if (store && route === rechargeCodesRoute) {
      if (!actor) return forbidden();
      return void handleRechargeCodes(request, response, actor);
    }
    if (store && route === orderSyncRoute) {
      if (!actor || !canManage) return forbidden();
      return void orderSync.handle(request, response, actor);
    }
    if (store && orderAuxiliaryRoutes.has(route)) {
      if (!actor || !canManage) return forbidden();
      return void handleOrderAuxiliary(request, response, route, actor);
    }
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
        !['/api/local/saved-totp', '/api/local/saved-totp/code'].includes(route) &&
        (request.method !== 'GET' || !['inventory', 'commerce'].includes(route.split('/').at(-1)))
      )
        return forbidden();
      return void localBusiness.handleLocalBusiness(request, response, route, store, actor, {
        publicOrigin: secureOrigin,
        readOrderCards: () => readPoolCards(orderRechargeClient),
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
    if (path === '/mailbox-query') {
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      );
    }
    let body = asset.body;
    if (store && asset === assets.get('/index.html')) body = Buffer.from(body.toString('utf8')
      .replace('<head>', '<head>\n<meta name="id-local-data-events" content="enabled" />'));
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
  if (store) server.once('close', () => store.close());
  if (dataChanges) server.once('close', () => dataChanges.close());
  if (rechargeOrderSync && orderSync && rechargeConfig) {
    const timer = setInterval(() => void orderSync.run({ apply: true }).catch(() => {}), 60_000);
    timer.unref();
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
  await new Promise((resolve, reject) => {
    const startFailed = (error) => {
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
  return { server, url: 'http://127.0.0.1:' + server.address().port + '/' };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const { values } = parseArgs({
      options: {
        'local-data': { type: 'boolean' },
        'public-origin': { type: 'string' },
        'data-dir': { type: 'string' },
        port: { type: 'string' },
        'finance-provider': { type: 'string' },
        'media-resolver-url': { type: 'string' },
        'website-analytics-config': { type: 'string' },
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
    const [websiteAnalyticsConfig, websiteVisitsSecret, microsoftMailboxConfig] = await Promise.all(
      [
        readToolConfig(values['website-analytics-config'], 'website-analytics'),
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
