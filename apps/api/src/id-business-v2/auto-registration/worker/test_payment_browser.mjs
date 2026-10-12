import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import console from 'node:console';
import { URL } from 'node:url';

const directory = new URL('.', import.meta.url);
const bridge = execFileSync(
  'python3',
  [
    '-c',
    "import ast,pathlib,sys; tree=ast.parse(pathlib.Path(sys.argv[1]).read_text()); print(next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='_PAYMENT_BROWSER_BRIDGE' for t in n.targets)))",
    fileURLToPath(new URL('workspace.py', directory))
  ],
  { encoding: 'utf8' }
);
const original = readFileSync(
  new URL('../upstream/static/js/payment.js', directory),
  'utf8'
).replaceAll('ui.showToast(', 'toast.show(');
const safeLink = 'https://chatgpt.com/checkout/openai_llc/cs_synthetic_only';

function fixture({ blocked = false, navigationFailure = false } = {}) {
  const status = { textContent: '' };
  const values = new Map([
    ['open-status', status],
    ['link-text', { value: '', select() {} }],
    ['account-select', { value: '7' }],
    ['country-select', { value: 'JP' }],
    ['workspace-name', { value: 'Synthetic Team' }],
    ['seat-quantity', { value: '7' }],
    ['price-interval', { value: 'year' }],
    ['link-box', { classList: { add() {} } }]
  ]);
  const calls = {
    opens: [],
    navigations: [],
    fetches: [],
    copies: [],
    messages: [],
    policies: [],
    closes: 0
  };
  const tab = {
    opener: {},
    document: {
      createElement: (tag) =>
        tag === 'a'
          ? {
              click() {
                if (navigationFailure) throw new Error('synthetic-navigation-failure');
                calls.navigations.push(this.href);
              },
              remove() {}
            }
          : {},
      head: { appendChild: (policy) => calls.policies.push(policy) },
      body: { appendChild() {} }
    },
    close() {
      calls.closes++;
    }
  };
  const context = vm.createContext({
    URL,
    console,
    document: {
      addEventListener() {},
      getElementById: (id) => values.get(id),
      querySelector: () => null,
      execCommand() {}
    },
    navigator: {
      clipboard: { writeText: async (value) => calls.copies.push(value) }
    },
    toast: { show: (...message) => calls.messages.push(message) },
    fetch: async (url, options) => {
      calls.fetches.push({ url, body: JSON.parse(options.body) });
      return { json: async () => ({ success: true, link: safeLink }) };
    },
    open: (...args) => {
      calls.opens.push(args);
      return blocked ? null : tab;
    }
  });
  context.window = context;
  vm.runInContext(original + '\n' + bridge, context);
  return {
    context,
    calls,
    tab,
    status,
    setLink: (value) => vm.runInContext(`generatedLink = ${JSON.stringify(value)}`, context)
  };
}

test('opens a validated checkout on the user browser with no opener or referrer, without server requests', () => {
  const f = fixture();
  f.setLink(safeLink);
  assert.equal(f.context.openIncognito(), true);
  assert.deepEqual(f.calls.opens, [['about:blank', '_blank']]);
  assert.deepEqual(f.calls.navigations, [safeLink]);
  assert.equal(f.tab.opener, null);
  assert.equal(f.calls.policies[0].name, 'referrer');
  assert.equal(f.calls.policies[0].content, 'no-referrer');
  assert.equal(f.calls.fetches.length, 0);
  assert.match(f.status.textContent, /当前浏览器/);
  assert.match(f.status.textContent, /手动开启/);
  assert.doesNotMatch(f.status.textContent, /已在无痕模式/);
});

test('blocked popup preserves a manual copy path and never claims it opened', async () => {
  const f = fixture({ blocked: true });
  f.setLink(safeLink);
  assert.equal(f.context.openIncognito(), false);
  assert.match(f.status.textContent, /阻止.*复制链接/);
  assert.deepEqual(f.calls.navigations, []);
  await f.context.copyLink();
  assert.deepEqual(f.calls.copies, [safeLink]);
  assert.equal(f.calls.fetches.length, 0);
});

test('navigation failure closes the placeholder and offers manual copy', () => {
  const f = fixture({ navigationFailure: true });
  f.setLink(safeLink);
  assert.equal(f.context.openIncognito(), false);
  assert.equal(f.calls.closes, 1);
  assert.match(f.status.textContent, /复制链接/);
});

test('dangerous, foreign and non-checkout URLs are neither opened nor copied', async () => {
  for (const link of [
    '',
    'javascript:alert(1)',
    'data:text/html,synthetic',
    'http://chatgpt.com/checkout/openai_llc/cs_synthetic_only',
    'https://chatgpt.com.example.invalid/checkout/openai_llc/cs_synthetic_only',
    'https://synthetic@chatgpt.com/checkout/openai_llc/cs_synthetic_only',
    'https://chatgpt.com:444/checkout/openai_llc/cs_synthetic_only',
    'https://chatgpt.com/checkout/openai_llc/../cs_synthetic_only',
    'https://chatgpt.com/other/../checkout/openai_llc/cs_synthetic_only',
    safeLink + '?next=https://example.invalid',
    safeLink + '#fragment',
    safeLink + '\n'
  ]) {
    const f = fixture();
    f.setLink(link);
    assert.equal(f.context.openIncognito(), false, link);
    await f.context.copyLink();
    assert.equal(f.calls.opens.length, 0, link);
    assert.equal(f.calls.copies.length, 0, link);
    assert.equal(f.calls.fetches.length, 0, link);
    assert.match(f.status.textContent, /允许范围/);
  }
});

test('original team checkout generation retains all business parameters', async () => {
  const f = fixture();
  vm.runInContext("selectedPlan = 'team'", f.context);
  await f.context.generateLink();
  assert.deepEqual(f.calls.fetches, [
    {
      url: '/api/payment/generate-link',
      body: {
        account_id: 7,
        plan_type: 'team',
        country: 'JP',
        workspace_name: 'Synthetic Team',
        seat_quantity: 7,
        price_interval: 'year'
      }
    }
  ]);
  assert.equal(f.calls.opens.length, 0);
  assert.equal(f.calls.navigations.length, 0);
  assert.equal(f.context.openIncognito(), true);
  assert.deepEqual(f.calls.navigations, [safeLink]);
});
