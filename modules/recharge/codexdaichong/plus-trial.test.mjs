import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const manifestUrl = new URL('./plus-trial/manifest.json', import.meta.url);
const patchUrl = new URL('./plus-trial/upstream-plus-trial.patch', import.meta.url);
const pricingFixture = new URL('../../../test/fixtures/pricing-checkout.post-routing.js.txt', import.meta.url);
const stripeFixture = new URL('../../../test/fixtures/stripe-payment.upstream.js.txt', import.meta.url);
const chatgptFixture = new URL('../../../test/fixtures/chatgpt.upstream.js.txt', import.meta.url);
const sessionAuthFixture = new URL('../../../test/fixtures/session-auth.upstream.js.txt', import.meta.url);

const prepareUrl = new URL('./prepare.mjs', import.meta.url);
const patchPath = fileURLToPath(patchUrl);

const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
const patch = await readFile(patchUrl);
// 补丁与清单按 LF 登记，Windows 检出的 CRLF 副本要先归一化再应用。
const normalize = (buffer) => Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
const fixtures = {
  'pricing-checkout.js': normalize(await readFile(pricingFixture)),
  'stripe-payment.js': normalize(await readFile(stripeFixture)),
  'chatgpt.js': normalize(await readFile(chatgptFixture)),
  'session-auth.js': normalize(await readFile(sessionAuthFixture))
};

function blobSha1(content) {
  return createHash('sha1').update('blob ' + content.length + '\0').update(content).digest('hex');
}

async function appliedSources() {
  const directory = await mkdtemp(join(tmpdir(), 'plus-trial-'));
  try {
    for (const [name, content] of Object.entries(fixtures)) await writeFile(join(directory, name), content);
    await exec('git', ['init', '-q'], { cwd: directory });
    await exec('git', ['-c', 'core.autocrlf=false', 'apply', patchPath], { cwd: directory });
    const text = {};
    for (const name of Object.keys(fixtures)) {
      text[name] = (await readFile(join(directory, name))).toString();
      await exec(process.execPath, ['--check', name], { cwd: directory });
    }
    return text;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('优惠账号补丁清单与内容一致', () => {
  assert.equal(manifest.revision, '4e9bb201cf481d4bcc85da34970fc26c63ab818a');
  assert.deepEqual(Object.keys(manifest.files).sort(),
    ['chatgpt.js', 'pricing-checkout.js', 'session-auth.js', 'stripe-payment.js']);
  assert.equal(createHash('sha256').update(patch).digest('hex'), manifest.patchSha256);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(names, ['chatgpt.js', 'pricing-checkout.js', 'session-auth.js', 'stripe-payment.js']);
});

test('三个基准分别是选路补丁结果与锁定上游文件', () => {
  for (const [name, content] of Object.entries(fixtures)) {
    assert.equal(blobSha1(content), manifest.files[name].original, name);
  }
});

test('补丁应用到三个基准后得到清单登记的结果文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plus-trial-'));
  try {
    for (const [name, content] of Object.entries(fixtures)) await writeFile(join(directory, name), content);
    await exec('git', ['init', '-q'], { cwd: directory });
    await exec('git', ['-c', 'core.autocrlf=false', 'apply', patchPath], { cwd: directory });
    for (const name of Object.keys(fixtures)) {
      assert.equal(blobSha1(await readFile(join(directory, name))), manifest.files[name].approved, name);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Plus 的 0 元购与半价优惠分别中止并说明原因', async () => {
  const { 'pricing-checkout.js': pricingText } = await appliedSources();
  assert.match(pricingText, /const PLUS_TRIAL_REFUSAL = '该账号为 Plus 0 元购优惠账号，不能继续充值 Plus，请转人工核对';/);
  assert.match(pricingText, /const PLUS_DISCOUNT_REFUSAL = '该账号为 Plus 半价优惠账号，不能继续充值 Plus，请转人工核对';/);
  const branch = pricingText.slice(pricingText.indexOf("    if (plan === 'plus') {"));
  const offerIndex = branch.indexOf('const offer = await findPlusOffer(page, currency);');
  const startNowIndex = branch.indexOf('const startNow = await findPlusStartNowButton(page);');
  assert.ok(offerIndex >= 0, 'Plus 分支缺少优惠账号检测');
  assert.ok(startNowIndex > offerIndex, '优惠账号检测必须先于点击升级按钮');
  assert.match(branch, /error\.code = discount \? 'PLUS_DISCOUNT_ACCOUNT' : 'PLUS_FREE_TRIAL_ACCOUNT';/);
});

test('定价页主按钮覆盖 Buy now 与 Get started', async () => {
  const { 'pricing-checkout.js': pricingText } = await appliedSources();
  assert.match(pricingText, /\/\^Buy now\$\/i, \/\^Get started\$\/i\],/);
  assert.match(pricingText, /const PRO_ACTION_PATTERN = \/\^\(\?:立即体验\|Buy now\|Start now\|Get started\|/);
  assert.match(pricingText, /const button = card\.getByRole\('button', \{ name: \/\^\(\?:Start now\|Buy now\|Get started\)\$\/i \}\);/);
});

test('Pro 0 元试用继续开通：允许 0 元金额与 Claim free offer 按钮', async () => {
  const { 'pricing-checkout.js': pricingText } = await appliedSources();
  assert.match(pricingText, /function readMoneyCents\(text, currency, monthly = false, \{ allowZero = false \} = \{\}\)/);
  assert.match(pricingText, /return amount > 0 \|\| allowZero \? amount : null;/);
  assert.match(pricingText, /async function readProMonthlyAmount\(card, currency, \{ allowZero = false \} = \{\}\)/);
  assert.match(pricingText, /if \(amount === 0\) console\.log\(`ℹ️ \[步骤\] Pro \$\{tier\} 显示 0 元试用，按正常开通继续`\);/);
});

test('0 元结账页不填卡：无卡号输入框且应付为 0 时直接提交', async () => {
  const { 'stripe-payment.js': stripeText } = await appliedSources();
  assert.match(stripeText, /async function isZeroAmountCheckout\(page\) \{/);
  const skipIndex = stripeText.indexOf('if (await isZeroAmountCheckout(page)) {');
  const fillIndex = stripeText.indexOf('const fillResult = await fillCardFieldsOpenAiCheckout(page, cardInfo, ELEMENT_TIMEOUT);');
  assert.ok(skipIndex > 0 && fillIndex > skipIndex, '0 元跳过点必须早于填卡');
  assert.match(stripeText, /Claim\\s\+\(\?:your\\s\+\)\?free\\s\+offer\|Claim\\s\+offer\|Start trial\|Start free trial\|Continue\|Confirm\|Get started\|Buy now/);
});

test('调试模式接受无卡结账页', async () => {
  const { 'chatgpt.js': chatgptText } = await appliedSources();
  assert.match(chatgptText, /async function isCheckoutSummaryReady\(page\) \{/);
  assert.match(chatgptText, /if \(await isCheckoutSummaryReady\(page\)\) \{/);
  const summaryIndex = chatgptText.indexOf('if (await isCheckoutSummaryReady(page)) {');
  const cardWaitIndex = chatgptText.indexOf('const cardSelector = [');
  assert.ok(summaryIndex > 0, '调试必须包含无卡结账页判据');
  assert.ok(cardWaitIndex > 0, '卡号输入框判据仍需保留');
  // API 建单成功后，Plus 的 0 元结账页同样必须中止。
  assert.match(chatgptText, /async function isPlusZeroAmountCheckout\(page\) \{/);
  assert.match(chatgptText, /code: 'PLUS_ZERO_AMOUNT_ACCOUNT'/);
  const guardIndex = chatgptText.indexOf("if (String(planType).toLowerCase() === 'plus' && await isPlusZeroAmountCheckout(page)) {");
  assert.ok(guardIndex > 0, 'API 建单成功后的 Plus 优惠拦截缺失');
});

test('会话在线校验改用 API 请求而不是页面导航', async () => {
  const { 'session-auth.js': sessionText } = await appliedSources();
  const start = sessionText.indexOf('async function verifyRealSessionApi(context) {');
  assert.ok(start > 0, '缺少 verifyRealSessionApi');
  const body = sessionText.slice(start, start + 900);
  assert.match(body, /context\.request\.get\(`\$\{CHATGPT_COOKIE_URL\}\/api\/auth\/session`/);
  assert.ok(!/probe\.goto\(/.test(body), '不得再用页面导航校验会话');
  assert.match(body, /maxRetries: 0/);
});

test('调试模式填卡与账单地址后停在提交前', async () => {
  const { 'stripe-payment.js': stripeText, 'chatgpt.js': chatgptText } = await appliedSources();
  assert.match(stripeText, /async function fillCheckoutForDebug\(page, \{ cardInfo, address, holderName \} = \{\}\) \{/);
  assert.match(stripeText, /fillCheckoutForDebug,/);
  assert.match(chatgptText, /process\.env\.CHECKOUT_DEBUG_FILL === '1'/);
  assert.match(chatgptText, /已填写银行卡与账单地址，按要求停在提交前/);
});

test('准备脚本与发布核验已覆盖四个文件', async () => {
  const prepare = (await readFile(prepareUrl, 'utf8')).replace(/\r\n/g, '\n');
  assert.match(prepare, /const plusTrialFiles = \['chatgpt\.js', 'pricing-checkout\.js', 'session-auth\.js', 'stripe-payment\.js'\];/);
  assert.match(prepare, /plusTrialFiles\.some\(name => routing\.files\[name\] && manifest\.files\[name\]\.original !== routing\.files\[name\]\.approved\)/);
});

test('清单篡改会被拒绝', () => {
  const tampered = structuredClone(manifest);
  tampered.files['chatgpt.js'].approved = '0'.repeat(40);
  const accepted = manifest.files['chatgpt.js'].approved === tampered.files['chatgpt.js'].approved
    && createHash('sha256').update(patch).digest('hex') === manifest.patchSha256;
  assert.equal(accepted, false);
});
