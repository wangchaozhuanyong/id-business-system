import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadCodexdaichongAssets } from '../../modules/recharge/codexdaichong/assets.mjs';
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const origin = 'https://design-layout.invalid';
let rechargeAssets;
export async function interceptDesign(context, { beforeDirectory, localFixtures, actor, changeEvents = false } = {}) {
  const unavailable = [],
    external = [];
  rechargeAssets ??= await loadCodexdaichongAssets();
  const handle = async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      external.push(url.origin);
      return route.abort();
    }
    const json = (body) => route.fulfill({ json: body });
    const prefix = '/integrations/codexdaichong';
    if (url.pathname === prefix + '/status') return json({ ready: true, admin: true });
    if (url.pathname.startsWith(prefix + '/api/')) {
      const resource = url.pathname.slice((prefix + '/api/').length);
      const fixtures = {
        'admin/session': { success: true, email: 'layout@example.test' },
        'admin/data': { stats: { total: 0, success: 0, failed: 0 }, config: {}, logs: [] },
        'admin/cdks': [],
        'admin/cards': { cards: [] },
        'admin/proxies': { proxies: [] },
        'admin/addresses': { addresses: [] },
        'admin/sessions': { items: [], total: 0 },
        'admin/task-logs': { tasks: [] },
        'admin/activation-manual-holds': { holds: [] },
        'admin/runtime-logs': { entries: [], nextAfter: 0 },
        'admin/login-logs': { logs: [] },
        'admin/ip-bans': { bans: [], activeCount: 0 },
        'admin/checkout/plans': { plans: {} },
        'admin/region': { region: 'PH', label: '离线合成地区', currency: 'PHP' },
        'admin/recharge-routing': {
          version: 1,
          regions: { PH: { label: '菲律宾', currency: 'PHP' }, EG: { label: '埃及', currency: 'EGP' } },
          plans: { plus: 'PH', pro100: 'EG', pro200: 'PH', pro500: 'EG' },
          checks: [], audit: [], auditCount: 0
        },
        'admin/gpt-api': { config: {} },
        'admin/gpt-api/status': {},
        'public/runtime': { runtime: { active_foreground_jobs: 0, max_foreground_jobs: 1 } },
        'public/payment-region': { region: 'PH', label: '离线合成地区', currency: 'PHP' }
      };
      return json(
        Array.isArray(fixtures[resource])
          ? fixtures[resource]
          : { success: true, ...fixtures[resource] }
      );
    }
    if (url.pathname.startsWith(prefix + '/')) {
      const asset = rechargeAssets.get(url.pathname.slice(prefix.length));
      if (asset)
        return route.fulfill({
          body: asset.body,
          contentType: asset.type,
          headers: asset.csp ? { 'content-security-policy': asset.csp } : {}
        });
    }
    if (url.pathname.startsWith('/api/')) {
      const resource = url.pathname.slice('/api/local/'.length);
      if (resource === 'apple-relay/status')
        return json({ configured: true, parentIds: [], aliasIds: [] });
      if (resource === 'audit') return json([]);
      return json(localFixtures?.[resource] ?? { version: 0, data: null, items: [] });
    }
    let file = path.join(
      root,
      'frontend',
      url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)
    );
    if (url.pathname === '/mailbox-query')
      file = path.join(root, 'frontend/apple-relay-public.html');
    if (url.pathname === '/integrations/bitbrowser/local-login')
      file = path.join(root, 'frontend/bitbrowser-local.html');
    if (url.pathname.startsWith('/assets/bitbrowser/')) {
      const suffix = url.pathname.slice('/assets/bitbrowser/'.length);
      file = path.join(
        root,
        suffix === 'local.mjs'
          ? 'frontend/bitbrowser-local.mjs'
          : suffix === 'proxies.mjs' ? 'frontend/bitbrowser-proxies.mjs'
          : 'modules/recharge/bitbrowser/' + suffix
      );
    }
    if (url.pathname.startsWith('/assets/finance/'))
      file = path.join(root, 'modules/finance', path.basename(url.pathname));
    if (url.pathname === '/assets/tools/totp.mjs') file = path.join(root, 'modules/tools/totp.mjs');
    if (
      beforeDirectory &&
      [
        'prototype.css',
        'prototype.js',
        'apple-relay-prototype.js',
        'operations-prototype.js'
      ].includes(path.basename(file))
    )
      file = path.join(beforeDirectory, path.basename(file));
    try {
      let body = await readFile(file);
      if (url.pathname === '/' && localFixtures)
        body = body
          .toString()
          .replace('<head>', changeEvents ? '<head><meta name="id-local-data-events" content="enabled">' : '<head>')
          .replace('<head>', actor
            ? `<head><meta name="id-local-auth" content="required"><meta name="id-local-actor" content="${encodeURIComponent(JSON.stringify(actor))}">`
            : '<head>')
          .replace(
            '    <script src="./prototype.js',
            '    <script src="/local-data.js" defer></script><script src="/toolbox-local.js" defer></script>\n    <script src="./prototype.js'
          )
          .replace(
            '</head>',
            '<script type="module" src="/assets/finance/browser.mjs"></script></head>'
          );
      return route.fulfill({
        body,
        contentType:
          {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.mjs': 'text/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml'
          }[path.extname(file)] || 'application/octet-stream'
      });
    } catch {
      unavailable.push(url.pathname);
      return route.fulfill({ status: 404, body: 'Offline fixture unavailable' });
    }
  };
  await context.route('**/*', handle);
  if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket) => socket.close());
  return { unavailable, external, handle };
}
export async function settle(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}
export async function separatorSnapshot(page, scope = '#main') {
  return page.locator(scope).evaluate((root) => {
    const visible = node => node.checkVisibility() && node.getBoundingClientRect().width > 0;
    const controls = [...root.querySelectorAll('.button,input:not([type=hidden]),select,textarea,summary')]
      .filter(node => visible(node) && !node.closest('table,.table-viewport,.title-description,[popover]'));
    const findings = [];
    let measurements = 0;
    for (const region of root.querySelectorAll('.list-controls,.content-toolbar,.panel-heading,.toolbar,.form-footer,.tool-header-row,.pagination,.form-section,.tabs')) {
      if (!visible(region)) continue;
      const box = region.getBoundingClientRect(), style = getComputedStyle(region);
      for (const side of ['Top', 'Bottom']) {
        if (!(parseFloat(style[`border${side}Width`]) > 0) || style[`border${side}Style`] === 'none') continue;
        const line = side === 'Top' ? box.top : box.bottom;
        for (const control of controls) {
          if (control.contains(region)) continue;
          const rect = control.getBoundingClientRect();
          if (rect.right <= box.left || rect.left >= box.right) continue;
          const distance = Math.max(rect.top - line, line - rect.bottom);
          if (distance >= 24) continue;
          measurements++;
          if (distance < 8 - 0.5) findings.push({
            region: region.className, side, control: control.id || control.getAttribute('aria-label') || control.textContent.trim().slice(0, 40),
            distance: Math.round(distance * 100) / 100
          });
        }
      }
    }
    return { measurements, findings };
  });
}
export async function spacingSnapshot(page, scope = '#main') {
  const result = await page.locator(scope).evaluate((root) => {
    const findings = [],
      cards = [];
    const visible = (el) => el.checkVisibility() && el.getBoundingClientRect().width > 0;
    for (const panel of root.querySelectorAll('.panel')) {
      if (!visible(panel)) continue;
      const rect = panel.getBoundingClientRect(),
        style = getComputedStyle(panel);
      cards.push({
        class: panel.className,
        padding: style.padding,
        children: [...panel.children].map((n) => n.tagName.toLowerCase() + '.' + n.className)
      });
      const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode,
          parent = node.parentElement;
        if (
          !node.textContent.trim() ||
          !visible(parent) ||
          parent.closest('.panel') !== panel ||
          parent.closest(
            'table,.title-description,svg,option,.tabs,.recharge-integration__nav,.empty-state'
          )
        )
          continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        if (!box.width || box.right < rect.left || box.left > rect.right) continue;
        const left = box.left - rect.left,
          right = rect.right - box.right,
          bottom = rect.bottom - box.bottom;
        if (left < 10 || right < 10 || bottom < 7)
          findings.push({
            text: node.textContent.trim().slice(0, 55),
            parent: parent.tagName + '.' + parent.className,
            panel: panel.className,
            left,
            right,
            bottom
          });
      }
      for (const control of panel.querySelectorAll(
        '.button,input:not([type=hidden]),textarea,select'
      )) {
        if (
          !visible(control) ||
          control.closest('.panel') !== panel ||
          control.closest('table,.tabs,.recharge-integration__nav')
        )
          continue;
        const box = control.getBoundingClientRect(),
          left = box.left - rect.left,
          right = rect.right - box.right,
          bottom = rect.bottom - box.bottom;
        if (left < 10 || right < 10 || bottom < 7)
          findings.push({
            control: control.id || control.textContent.slice(0, 45),
            panel: panel.className,
            left,
            right,
            bottom
          });
      }
    }
    return { findings, cards, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  const separators = await separatorSnapshot(page, scope);
  return { ...result, separators, findings: [...result.findings, ...separators.findings] };
}
