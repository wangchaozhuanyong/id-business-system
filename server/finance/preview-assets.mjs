import { readFile } from 'node:fs/promises';

export async function installFinanceAssets(assets, { automaticQuotes = false } = {}) {
  const index = assets.get('/index.html');
  const anchor = '    <script src="./commerce-prototype.js';
  const html = index.body.toString('utf8');
  if (!html.includes(anchor)) throw new Error('未找到订单模块的脚本入口');
  for (const name of ['accounting', 'browser']) {
    assets.set(`/assets/finance/${name}.mjs`, {
      type: 'text/javascript; charset=utf-8',
      body: await readFile(new URL(`../../modules/finance/${name}.mjs`, import.meta.url))
    });
  }
  const end = html.indexOf('</script>', html.indexOf(anchor)) + '</script>'.length;
  index.body = Buffer.from(
    html.slice(0, end) + '\n    <script type="module" src="/assets/finance/browser.mjs"></script>' +
    (automaticQuotes ? '\n    <meta name="id-finance-auto-quote" content="enabled" />' : '') +
    html.slice(end)
  );
}
