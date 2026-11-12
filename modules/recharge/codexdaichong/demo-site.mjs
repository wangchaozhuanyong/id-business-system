import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { startPreview } from '../../../server/preview.mjs';
import { loadCodexdaichongAssets } from './assets.mjs';
import { CODEXDAICHONG_PREFIX as prefix, createCodexdaichongGateway } from './gateway.mjs';

const demoPlans = new Map([
  ['KC-DEMO-ONLY', { type: 'plus', label: '演示 Plus' }],
  ['KC-DEMO-02', { type: 'pro100', label: '演示 Pro 100' }],
  ['KC-DEMO-03', { type: 'pro200', label: '演示 Pro 200' }]
]);
const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const mockActor = Object.freeze({
  id: 'recharge-demo-only',
  email: 'demo@example.test',
  admin: true,
  sensitive: true
});
const root = '/api/admin/';
const demoOnly = '本机演示仅支持查看，此操作需要真实渠道';
const adminReadControls = [
  '[data-switcher-tab]',
  '[data-view-task-log]',
  '#cdk_search',
  '#session_search',
  '#runtime_log_refresh_btn',
  '#runtime_log_pause',
  '#runtime_log_autoscroll',
  '#checkout_log_autoscroll',
  ...[
    'loadCdkList()',
    'loadProxyPool()',
    'loadSessions(true)',
    'searchSessions()',
    'loadTaskLogs(true)',
    'loadActivationManualHolds(true)',
    'loadIpBans()',
    'loadAdminLoginLogs()',
    'refreshCheckoutDebugLogs()',
    'closeTaskLogModal()',
    "toggleFilterMenu('cdk",
    "selectFilter('cdk'",
    'selectCdkPlanTypeFilter('
  ].map((action) => '[onclick^="' + action + '"]')
].join(',');

const adminReads = {
  proxies: { proxies: [] },
  addresses: { addresses: [] },
  sessions: { items: [], total: 0 },
  'ip-bans': { bans: [], activeCount: 0 },
  'checkout/plans': { plans: {} },
  'orbitcard/config': { config: {} },
  'security/status': {},
  'hcaptcha/logs': { logs: [] },
  'orbitcard/usage': { rows: [], total: 0 },
  'orbitcard/products': { products: [] },
  'orbitcard/product-strategy': { config: {} },
  region: { region: 'PH', label: '菲律宾（演示）', currency: 'PHP' }
};

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readDemoBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 4096) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

export async function startCodexdaichongDemoSite(
  port = 0,
  { now = Date.now, failAdminRefresh = () => false } = {}
) {
  const demoUser = randomUUID();
  const demoSession = JSON.stringify({
    user: { id: demoUser, email: mockActor.email },
    accessToken: [
      part({ typ: 'JWT', alg: 'RS256' }),
      part({
        iss: 'https://auth.openai.com',
        aud: ['https://api.openai.com/v1'],
        scp: ['model.request'],
        exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60,
        'https://api.openai.com/auth': { chatgpt_account_id: demoUser, chatgpt_user_id: demoUser }
      }),
      'unsigned-demo-only'
    ].join('.')
  });
  const jobs = new Map();
  const secret = randomBytes(32).toString('hex');
  function readJob(job) {
    if (!job) return null;
    const running = now() - job.startedAt < 1500;
    return {
      jobKey: job.jobKey,
      cdkCode: job.cdk,
      status: running ? 'running' : 'manual',
      progress: running ? 35 : 70,
      message: running ? '演示任务正在处理' : '演示任务已转待人工核对',
      phone: null,
      cardLast4: null,
      captcha: null,
      isTerminal: !running
    };
  }
  function queryCdk(cdk) {
    const task = readJob(jobs.get(cdk));
    const plan = demoPlans.get(cdk);
    const processing = task?.status === 'running';
    return {
      cdk,
      status: processing ? '开通中' : '未使用',
      type: '自助',
      planType: plan.type,
      planLabel: plan.label,
      createdAt: null,
      jobKey: processing ? task.jobKey : null,
      usedAt: null,
      accountEmail: task ? mockActor.email : null
    };
  }
  const mock = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    if (!req.headers['x-id-recharge-assertion'] || req.socket.remoteAddress !== '127.0.0.1')
      return json(res, { success: false }, 401);
    if (req.method === 'POST') {
      if (!['/api/verify-cdk', '/api/run-process', '/api/cdk/query-batch'].includes(path))
        return json(res, { success: false, message: '演示站不执行此操作' }, 403);
      const body = await readDemoBody(req).catch(() => null);
      if (path === '/api/cdk/query-batch') {
        if (
          !Array.isArray(body?.cdks) ||
          !body.cdks.length ||
          body.cdks.some((code) => !demoPlans.has(code))
        )
          return json(res, { success: false, message: '仅接受演示兑换码' }, 400);
        const results = [...new Set(body.cdks)].map(queryCdk);
        const processing = results.filter((result) => result.status === '开通中').length;
        return json(res, {
          success: true,
          data: {
            summary: {
              total: results.length,
              unused: results.length - processing,
              processing,
              used: 0,
              notFound: 0
            },
            results
          }
        });
      }
      const cdk = body?.cdk;
      const plan = demoPlans.get(cdk);
      if (!plan)
        return json(
          res,
          { success: false, message: '仅接受演示兑换码，请使用页面上的演示资料' },
          400
        );
      if (path === '/api/verify-cdk')
        return json(res, { success: true, data: { plan_type: plan.type, plan_label: plan.label } });
      if (body.session !== demoSession)
        return json(res, { success: false, message: '仅接受页面生成的演示授权资料' }, 400);
      let job = jobs.get(cdk);
      if (!job) {
        job = { cdk, jobKey: randomUUID(), startedAt: now() };
        jobs.set(cdk, job);
      }
      return json(res, { success: true, jobKey: job.jobKey });
    }
    if (!['GET', 'HEAD'].includes(req.method))
      return json(res, { success: false, message: '演示站不执行此操作' }, 403);
    if (path === '/api/public/runtime')
      return json(res, {
        success: true,
        runtime: { active_foreground_jobs: 0, max_foreground_jobs: 1 }
      });
    if (path === '/api/public/payment-region')
      return json(res, { success: true, region: 'PH', label: '菲律宾（演示）', currency: 'PHP' });
    const cdk = url.searchParams.get('cdk');
    if (path === '/api/cdk/query' && demoPlans.has(cdk))
      return json(res, { success: true, data: queryCdk(cdk) });
    if (path.startsWith('/api/task-status/')) {
      const job = [...jobs.values()].find((item) => path === '/api/task-status/' + item.jobKey);
      if (job) return json(res, { success: true, data: readJob(job) });
      return json(res, { success: false, message: '未找到该任务' }, 404);
    }
    if (path === root + 'session') return json(res, { success: true, email: mockActor.email });
    if (path === root + 'data') {
      if (failAdminRefresh())
        return json(res, { success: false, message: '演示服务暂不可用' }, 503);
      return json(res, {
        stats: { total: jobs.size, success: 0, failed: 0 },
        config: {},
        logs: []
      });
    }
    if (path === root + 'cdks')
      return json(
        res,
        [...demoPlans].map(([code, plan]) => ({
          code,
          plan_type: plan.type,
          status: queryCdk(code).jobKey ? 'processing' : 'unused'
        }))
      );
    if (path === root + 'cards')
      return json(res, { planPolicy: { version: 0, strict: false },
        cards: [{ id: 1, last4: '0007', card_holder: '虚构演示持卡人', allowed_plans: null }] });
    const tasks = [...jobs.values()].map(readJob);
    if (path === root + 'task-logs')
      return json(res, {
        tasks: tasks.map((task) => ({ ...task, id: task.jobKey, cdk: task.cdkCode }))
      });
    const task = tasks.find((item) => path === root + 'task-logs/' + item.jobKey);
    if (task) return json(res, { success: true, task, runtimeEntries: [] });
    if (path === root + 'activation-manual-holds')
      return json(res, {
        success: true,
        holds: tasks
          .filter((item) => item.status === 'manual')
          .map((item, index) => ({
            id: index + 1,
            jobKey: item.jobKey,
            cdkCode: item.cdkCode,
            planType: demoPlans.get(item.cdkCode).type,
            accountEmail: mockActor.email,
            reason: item.message
          }))
      });
    if (path === root + 'runtime-logs') {
      const entries = [
        {
          id: 1,
          ts: now(),
          level: 'info',
          text: '本机模拟上游已就绪'
        }
      ];
      return json(res, {
        success: true,
        entries: Number(url.searchParams.get('after')) >= 1 ? [] : entries,
        nextAfter: 1
      });
    }
    if (path === root + 'login-logs')
      return json(res, {
        logs: [
          {
            event: 'login_success',
            admin_email: mockActor.email,
            ip: '127.0.0.1',
            detail: '本机演示会话'
          }
        ]
      });
    const adminRead = path.startsWith(root) && path.slice(root.length);
    if (
      adminRead &&
      Object.hasOwn(adminReads, adminRead) &&
      url.searchParams.get('refresh') !== '1'
    )
      return json(res, { success: true, ...adminReads[adminRead] });
    return json(res, { success: false, message: '此查询没有演示数据' }, 404);
  });

  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  let gateway;
  try {
    const host = await startPreview(port, {
      databasePath: ':memory:',
      codexdaichong: {
        handle: (req, res) => gateway.handle(req, res),
        upgrade: (_req, socket) => socket.destroy()
      }
    });
    gateway = createCodexdaichongGateway({
      upstreamUrl: 'http://127.0.0.1:' + mock.address().port,
      publicOrigin: new URL(host.url).origin,
      secret,
      getUnifiedPrincipal: () => mockActor,
      assets: async () => {
        const assets = await loadCodexdaichongAssets();
        for (const route of ['/redeem', '/workspace', '/admin', '/subscription']) {
          const page = assets.get(route);
          page.body = page.body.replace(
            '</head>',
            '<script defer src="' + prefix + '/demo-only.js"></script></head>'
          );
        }
        assets.set('/demo-only.js', {
          type: 'text/javascript; charset=utf-8',
          body: `
            const notice = document.createElement('div');
            notice.setAttribute('role', 'note');
            const view = document.body.dataset.rechargeView;
            notice.textContent = view === 'redeem'
              ? '本机隔离测试 · 使用演示资料验码、提交和查单。重启会清空演示任务。'
              : '本机隔离测试 · 仅供查看。外部渠道和后台写入已禁用。';
            notice.className = 'recharge-demo-note';
            document.body.prepend(notice);
            const readControls = ${JSON.stringify(adminReadControls)};
            const reason = ${JSON.stringify(demoOnly)};
            const controls = 'button,input,textarea,select';
            const disabledActions = '.cdk-copy[onclick],[onclick="logoutAdmin()"]';
            function applyDemoLimits() {
              for (const link of document.querySelectorAll('a[href^="https://"],a[href^="http://"]')) {
                if (new URL(link.href).origin === location.origin) continue;
                link.removeAttribute('href');
                link.setAttribute('aria-disabled', 'true');
                link.title = reason;
              }
              if (view === 'redeem') return;
              for (const field of document.querySelectorAll(controls)) {
                if (view === 'admin' && field.matches(readControls)) continue;
                if (!field.disabled) field.disabled = true;
                if (field.title !== reason) field.title = reason;
              }
              for (const action of document.querySelectorAll(disabledActions)) {
                action.removeAttribute('onclick');
                action.setAttribute('aria-disabled', 'true');
                action.tabIndex = -1;
                action.title = reason;
              }
            }
            applyDemoLimits();
            new MutationObserver(applyDemoLimits).observe(document.body, {
              subtree: true, childList: true, attributes: true,
              attributeFilter: ['disabled', 'href', 'onclick']
            });
            if (view === 'redeem') {
              const authorization = document.getElementById('tokenInput');
              authorization.readOnly = true;
              authorization.dataset.demoReadonly = 'true';
              authorization.title = '请使用页面生成的演示授权资料';
              const fill = document.createElement('button');
              const sample = document.createElement('select');
              sample.setAttribute('aria-label', '演示兑换码样例');
              for (const [code, label] of ${JSON.stringify([...demoPlans].map(([code, plan]) => [code, plan.label]))})
                sample.add(new Option(label, code));
              fill.type = 'button';
              fill.textContent = '填入演示资料';
              fill.className = 'btn-secondary';
              fill.addEventListener('click', () => {
                if (document.documentElement.dataset.rechargeNavigationLocked === 'true') return;
                for (const [id, value] of [['cdkInput', sample.value], ['queryInput', sample.value], ['tokenInput', ${JSON.stringify(demoSession)}]]) {
                  const field = document.getElementById(id);
                  if (id === 'cdkInput' && field.readOnly) continue;
                  field.value = value;
                  if (id !== 'tokenInput' || document.querySelector('#step2').style.display !== 'none')
                    field.dispatchEvent(new Event('input', { bubbles: true }));
                }
              });
              notice.append(sample, fill);
            }
          `
        });
        return assets;
      }
    });
    host.server.once('close', () => mock.close());
    return { ...host, rechargeUrl: host.url + '#/online-recharge/chatgpt' };
  } catch (error) {
    mock.close();
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const { rechargeUrl } = await startCodexdaichongDemoSite(Number(process.argv[2] ?? 0));
    console.log('最新版本机隔离测试：' + rechargeUrl);
  } catch (error) {
    console.error('本机测试站启动失败：' + error.message);
    process.exitCode = 1;
  }
}
