// Offline screenshots only. No web server, database, production reads or writes.
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { interceptDesign, origin, root, settle } from './helpers/offline-design.mjs';
import { fixtures } from './helpers/visual-redesign-fixtures.mjs';
const exec = promisify(execFile), output = path.join(root, '.runtime/visual-redesign-20261110');
const baseline = path.join(output, 'before-source');
await mkdir(baseline, { recursive: true });
await exec('git', ['archive', '--format=tar', '--output', path.join(output, 'before-source.tar'), 'HEAD', 'frontend'], { cwd: root });
await exec('tar', ['-xf', path.join(output, 'before-source.tar'), '-C', baseline], { cwd: root });
const browser = await chromium.launch();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mjs': 'text/javascript' };
const inject = source => source.replace('    <script src="./prototype.js',
  '    <script src="/local-data.js" defer></script><script src="/toolbox-local.js" defer></script>\n    <script src="./prototype.js')
  .replace('</head>', '<script type="module" src="/assets/finance/browser.mjs"></script></head>');
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, serviceWorkers: 'block' });
  await interceptDesign(context, { localFixtures: fixtures });
  await context.route(origin + '/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/integrations/')) return route.fallback();
    const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
    try {
      const source = await readFile(path.join(baseline, 'frontend', name), 'utf8');
      return route.fulfill({ body: name === 'index.html' ? inject(source) : source, contentType: types[path.extname(name)] });
    } catch { return route.fallback(); }
  });
  const before = await context.newPage();
  await before.goto(origin + '/#/overview');
  await before.waitForFunction(() => document.querySelector('.overview-metric-value strong')?.textContent === '28');
  for (const route of ['overview', 'orders/gpt', 'workspace/order/gpt']) {
    await before.evaluate(route => { location.hash = '#/' + route; }, route);
    await before.locator('#main[data-layout-route="' + route + '"]').waitFor();
    await settle(before);
    await before.screenshot({ path: path.join(output, 'before-' + route.replaceAll('/', '-') + '.png'), fullPage: true });
  }
  await context.close();
  const current = await browser.newContext({ viewport: { width: 1440, height: 1080 }, serviceWorkers: 'block' });
  const requests = await interceptDesign(current, { localFixtures: fixtures });
  const page = await current.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1080 });
    await page.goto(origin + '/mailbox-query');
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await settle(page);
    await page.screenshot({ path: path.join(output, 'after-public-mailbox-' + width + '-' + theme + '.png'), fullPage: true });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('公开查询页溢出');
  }
  await current.route(origin + '/?design-login=1', async route => {
    let source = await readFile(path.join(root, 'frontend/index.html'), 'utf8');
    source = inject(source).replace('<head>', '<head><meta name="id-local-auth" content="required">')
      .replace('    <script src="./prototype.js',
        '<link rel="stylesheet" href="/local-auth.css"><script src="/local-auth.js" defer></script>\n    <script src="./prototype.js');
    return route.fulfill({ body: source, contentType: 'text/html' });
  });
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin + '/?design-login=1');
    await page.locator('#local-auth-gate').waitFor();
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: path.join(output, 'after-login-' + width + '-' + theme + '.png'), fullPage: true });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('登录页溢出');
  }
  if (errors.length || requests.unavailable.length || requests.external.length) throw Error(JSON.stringify({ errors, requests }));
  await writeFile(path.join(output, 'public-and-baseline.json'), JSON.stringify({ before: 3, public: 6, login: 6, errors }, null, 2));
  console.log('通过：同样例改版前截图 3 张；公开查询 6 个主题/宽度组合；登录页 6 个主题/宽度组合。');
} finally { await browser.close(); }
