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
const browserPoolFixture = new URL('../../../test/fixtures/browser-pool.upstream.js.txt', import.meta.url);

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
  'session-auth.js': normalize(await readFile(sessionAuthFixture)),
  'browser-pool.js': normalize(await readFile(browserPoolFixture))
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
    ['browser-pool.js', 'chatgpt.js', 'pricing-checkout.js', 'session-auth.js', 'stripe-payment.js']);
  assert.equal(createHash('sha256').update(patch).digest('hex'), manifest.patchSha256);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(names, ['browser-pool.js', 'chatgpt.js', 'pricing-checkout.js', 'session-auth.js', 'stripe-payment.js']);
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
  assert.match(stripeText, /async function fillCheckoutForDebug\(page, \{ cardInfo, holderName \} = \{\}\) \{/);
  assert.match(stripeText, /pickBillingAddressForCheckout\(null\)/);
  assert.match(stripeText, /fillCheckoutForDebug,/);
  assert.match(chatgptText, /process\.env\.CHECKOUT_DEBUG_FILL === '1'/);
  // 调试复用真实支付流程：dryRun 在提交前返回，不点击付款。
  assert.match(stripeText, /if \(options\.dryRun\) \{/);
  assert.match(stripeText, /dry_run_stopped_before_submit/);
  assert.match(chatgptText, /dryRun: true/);
  assert.match(chatgptText, /已按真实支付流程填完卡与地址，停在提交前/);
  // 结果不明时用账号套餐核实，避免把未扣费误判成待核实。
  assert.match(stripeText, /function verifyAccountPlan\(accessToken\) \{/);
  assert.match(stripeText, /付款未成立，账号未扣费/);
});

test('准备脚本与发布核验已覆盖四个文件', async () => {
  const prepare = (await readFile(prepareUrl, 'utf8')).replace(/\r\n/g, '\n');
  assert.match(prepare, /const plusTrialFiles = \['browser-pool\.js', 'chatgpt\.js', 'pricing-checkout\.js', 'session-auth\.js', 'stripe-payment\.js'\];/);
  assert.match(prepare, /plusTrialFiles\.some\(name => routing\.files\[name\] && manifest\.files\[name\]\.original !== routing\.files\[name\]\.approved\)/);
});

test('清单篡改会被拒绝', () => {
  const tampered = structuredClone(manifest);
  tampered.files['chatgpt.js'].approved = '0'.repeat(40);
  const accepted = manifest.files['chatgpt.js'].approved === tampered.files['chatgpt.js'].approved
    && createHash('sha256').update(patch).digest('hex') === manifest.patchSha256;
  assert.equal(accepted, false);
});

test('国家与州选择带硬超时和键盘兜底，避免整轮卡死', async () => {
  const { 'stripe-payment.js': stripeText } = await appliedSources();
  // 国家：25 秒硬超时 + 键盘兜底
  assert.match(stripeText, /选择国家超时（25s），继续填后续字段/);
  assert.match(stripeText, /改走键盘选择国家/);
  assert.match(stripeText, /United States/);
  // 州：20 秒硬超时 + 键盘兜底
  assert.match(stripeText, /选择州超时（20s），继续后续步骤/);
  assert.match(stripeText, /改走键盘选择州/);
  // 两处都用 Promise.race 包裹，保证不会无限等待
  const raceCount = (stripeText.match(/return Promise\.race\(\[attempt, timed\]\);/g) || []).length;
  assert.equal(raceCount, 2);
});

test('无卡结账页判定必须金额为零，Pro 不会被误判为免费', async () => {
  const { 'chatgpt.js': chatgptText } = await appliedSources();
  // 只有金额为 0 才算 0 元试用
  assert.match(chatgptText, /只有金额为 0 才是真正的 0 元试用/);
  assert.match(chatgptText, /isZeroAmount/);
  assert.match(chatgptText, /0 元试用结账页已加载（无需填卡）/);
  // 金额非 0 却无卡号框时报「支付表单未渲染」，不再当成无卡
  assert.match(chatgptText, /支付表单未渲染/);
  assert.match(chatgptText, /paymentFormMissing: true/);
  // 旧的「无卡结账页已加载」措辞不再单独出现
  assert.doesNotMatch(chatgptText, /无卡结账页已加载，调试已停止（未填卡、未付款）/);
});

test('续费提示：已有未到期订阅给出明确失败原因', async () => {
  const { 'chatgpt.js': chatgptText } = await appliedSources();
  // API 侧：把 already_subscribed / active_subscription 转成中文失败原因
  assert.match(chatgptText, /already_subscription|has_active_subscription/);
  assert.match(chatgptText, /reason: 'already_subscribed'/);
  assert.match(chatgptText, /该账号已有未到期的订阅，无法重复购买，请到期后再充值/);
  // 不符合套餐/地区条件也给出明确原因
  assert.match(chatgptText, /reason: 'not_eligible'/);
  assert.match(chatgptText, /该账号不符合当前套餐或地区的订阅条件/);
  // 无权开通
  assert.match(chatgptText, /reason: 'no_permission'/);
});
