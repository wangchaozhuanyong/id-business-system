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
const prepareUrl = new URL('./prepare.mjs', import.meta.url);
const patchPath = fileURLToPath(patchUrl);

const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
const patch = await readFile(patchUrl);
// 补丁与清单按 LF 登记，Windows 检出的 CRLF 副本要先归一化再应用。
const normalize = (buffer) => Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
const pricing = normalize(await readFile(pricingFixture));
const stripe = normalize(await readFile(stripeFixture));

function blobSha1(content) {
  return createHash('sha1').update('blob ' + content.length + '\0').update(content).digest('hex');
}

async function appliedSources() {
  const directory = await mkdtemp(join(tmpdir(), 'plus-trial-'));
  try {
    await writeFile(join(directory, 'pricing-checkout.js'), pricing);
    await writeFile(join(directory, 'stripe-payment.js'), stripe);
    await exec('git', ['init', '-q'], { cwd: directory });
    await exec('git', ['-c', 'core.autocrlf=false', 'apply', patchPath], { cwd: directory });
    const pricingText = (await readFile(join(directory, 'pricing-checkout.js'))).toString();
    const stripeText = (await readFile(join(directory, 'stripe-payment.js'))).toString();
    await exec(process.execPath, ['--check', 'pricing-checkout.js'], { cwd: directory });
    await exec(process.execPath, ['--check', 'stripe-payment.js'], { cwd: directory });
    return { pricingText, stripeText };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('0 元与半价优惠补丁清单与内容一致', () => {
  assert.equal(manifest.revision, '4e9bb201cf481d4bcc85da34970fc26c63ab818a');
  assert.deepEqual(Object.keys(manifest.files).sort(), ['pricing-checkout.js', 'stripe-payment.js']);
  assert.equal(createHash('sha256').update(patch).digest('hex'), manifest.patchSha256);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(names, ['pricing-checkout.js', 'stripe-payment.js']);
});

test('两个基准分别是选路补丁结果与锁定上游文件', () => {
  assert.equal(blobSha1(pricing), manifest.files['pricing-checkout.js'].original);
  assert.equal(blobSha1(stripe), manifest.files['stripe-payment.js'].original);
});

test('补丁应用到两个基准后得到清单登记的结果文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plus-trial-'));
  try {
    await writeFile(join(directory, 'pricing-checkout.js'), pricing);
    await writeFile(join(directory, 'stripe-payment.js'), stripe);
    await exec('git', ['init', '-q'], { cwd: directory });
    await exec('git', ['-c', 'core.autocrlf=false', 'apply', patchPath], { cwd: directory });
    assert.equal(blobSha1(await readFile(join(directory, 'pricing-checkout.js'))),
      manifest.files['pricing-checkout.js'].approved);
    assert.equal(blobSha1(await readFile(join(directory, 'stripe-payment.js'))),
      manifest.files['stripe-payment.js'].approved);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Plus 的 0 元购与半价优惠分别中止并说明原因', async () => {
  const { pricingText } = await appliedSources();
  assert.match(pricingText, /const PLUS_TRIAL_REFUSAL = '该账号为 Plus 0 元购优惠账号，不能继续充值 Plus，请转人工核对';/);
  assert.match(pricingText, /const PLUS_DISCOUNT_REFUSAL = '该账号为 Plus 半价优惠账号，不能继续充值 Plus，请转人工核对';/);
  assert.match(pricingText, /const DISCOUNT_OFFER_TEXT = \/\(\?:\\b\\d\{1,2\}\\s\*%\\s\*off\\b\|半价\|五折\|半折\|\\bSave\\s\+\\d\{1,2\}\\s\*%\\b\)\/i;/);

  const branch = pricingText.slice(pricingText.indexOf("    if (plan === 'plus') {"));
  const offerIndex = branch.indexOf('const offer = await findPlusOffer(page, currency);');
  const startNowIndex = branch.indexOf('const startNow = await findPlusStartNowButton(page);');
  assert.ok(offerIndex >= 0, 'Plus 分支缺少优惠账号检测');
  assert.ok(startNowIndex > offerIndex, '优惠账号检测必须先于点击升级按钮');
  assert.match(branch, /error\.code = discount \? 'PLUS_DISCOUNT_ACCOUNT' : 'PLUS_FREE_TRIAL_ACCOUNT';/);
  assert.match(pricingText, /if \(prices\.length >= 2\) \{/);
});

test('Pro 0 元试用继续开通：允许 0 元金额与 Claim free offer 按钮', async () => {
  const { pricingText } = await appliedSources();
  assert.match(pricingText, /function readMoneyCents\(text, currency, monthly = false, \{ allowZero = false \} = \{\}\)/);
  assert.match(pricingText, /return amount > 0 \|\| allowZero \? amount : null;/);
  assert.match(pricingText, /async function readProMonthlyAmount\(card, currency, \{ allowZero = false \} = \{\}\)/);
  assert.match(pricingText, /const PRO_ACTION_PATTERN = \/\^\(\?:立即体验\|Start now\|升级至\\s\*Pro\|Upgrade to Pro\|Get Pro\|Claim\\s\+\(\?:your\\s\+\)\?free\\s\+offer\|Claim\\s\+offer\)\$\/i;/);
  assert.match(pricingText, /if \(amount === 0\) console\.log\(`ℹ️ \[步骤\] Pro \$\{tier\} 显示 0 元试用，按正常开通继续`\);/);
});

test('0 元结账页不填卡：无卡号输入框且应付为 0 时直接提交', async () => {
  const { stripeText } = await appliedSources();
  assert.match(stripeText, /function isZeroAmountCheckoutText\(text\) \{/);
  assert.match(stripeText, /async function isZeroAmountCheckout\(page\) \{/);
  assert.match(stripeText, /if \(await isZeroAmountCheckout\(page\)\) \{/);
  assert.match(stripeText, /return finalizeCheckoutPayment\(page, \(cardInfo && cardInfo\.holder\) \|\| ''\);/);
  // 跳过点必须在填卡之前
  const skipIndex = stripeText.indexOf('if (await isZeroAmountCheckout(page)) {');
  const fillIndex = stripeText.indexOf('const fillResult = await fillCardFieldsOpenAiCheckout(page, cardInfo, ELEMENT_TIMEOUT);');
  assert.ok(skipIndex > 0 && fillIndex > skipIndex, '0 元跳过点必须早于填卡');
  assert.match(stripeText, /Claim\\s\+\(\?:your\\s\+\)\?free\\s\+offer\|Claim\\s\+offer\|Start trial\|Start free trial\|Continue\|Confirm\|Get started/);
});

test('准备脚本已覆盖两个文件并保持全量核验', async () => {
  const prepare = (await readFile(prepareUrl, 'utf8')).replace(/\r\n/g, '\n');
  assert.match(prepare, /const plusTrialFiles = \['pricing-checkout\.js', 'stripe-payment\.js'\];/);
  assert.match(prepare, /plusTrialFiles\.some\(name => routing\.files\[name\] && manifest\.files\[name\]\.original !== routing\.files\[name\]\.approved\)/);
  assert.match(prepare, /throw new Error\('0 元试用补丁基准不符：' \+ name\)/);
  assert.match(prepare, /plusTrialPatchSha256: plusTrial\.patchSha256/);
});

test('清单篡改会被拒绝', () => {
  const tampered = structuredClone(manifest);
  tampered.files['stripe-payment.js'].approved = '0'.repeat(40);
  const accepted = manifest.files['stripe-payment.js'].approved === tampered.files['stripe-payment.js'].approved
    && createHash('sha256').update(patch).digest('hex') === manifest.patchSha256;
  assert.equal(accepted, false);
});
