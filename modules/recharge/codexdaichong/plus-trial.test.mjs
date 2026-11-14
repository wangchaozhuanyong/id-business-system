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
const fixtureUrl = new URL('../../../test/fixtures/pricing-checkout.post-routing.js', import.meta.url);
const prepareUrl = new URL('./prepare.mjs', import.meta.url);
const patchPath = fileURLToPath(patchUrl);

const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
const patch = await readFile(patchUrl);
const fixture = await readFile(fixtureUrl);

function blobSha1(content) {
  return createHash('sha1').update('blob ' + content.length + '\0').update(content).digest('hex');
}

test('0 元试用补丁清单与补丁内容一致', () => {
  assert.equal(manifest.revision, '4e9bb201cf481d4bcc85da34970fc26c63ab818a');
  assert.deepEqual(Object.keys(manifest.files), ['pricing-checkout.js']);
  assert.equal(createHash('sha256').update(patch).digest('hex'), manifest.patchSha256);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map((match) => match[1]);
  assert.deepEqual(names, ['pricing-checkout.js']);
});

test('补丁基准是选路补丁后的 pricing-checkout.js', () => {
  assert.equal(blobSha1(fixture), manifest.files['pricing-checkout.js'].original);
});

test('补丁应用到基准文件后得到清单登记的结果文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plus-trial-'));
  try {
    await writeFile(join(directory, 'pricing-checkout.js'), fixture);
    await exec('git', ['init', '-q'], { cwd: directory });
    await exec('git', ['-c', 'core.autocrlf=false', 'apply', patchPath], { cwd: directory });
    const applied = await readFile(join(directory, 'pricing-checkout.js'));
    assert.equal(blobSha1(applied), manifest.files['pricing-checkout.js'].approved);
    // 补丁结果必须是可解析的 CommonJS，避免只改文本改出语法错误。
    await exec(process.execPath, ['--check', 'pricing-checkout.js'], { cwd: directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Plus 0 元试用在点击升级前被拦下并提示转人工', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plus-trial-'));
  try {
    await writeFile(join(directory, 'pricing-checkout.js'), fixture);
    await exec('git', ['init', '-q'], { cwd: directory });
    await exec('git', ['-c', 'core.autocrlf=false', 'apply', patchPath], { cwd: directory });
    const applied = (await readFile(join(directory, 'pricing-checkout.js'))).toString();

    assert.match(applied, /const PLUS_TRIAL_REFUSAL = '该账号为 Plus 0 元试用资格账号，不能继续充值 Plus，请转人工核对';/);
    const plusBranch = applied.slice(applied.indexOf("    if (plan === 'plus') {"));
    const trialIndex = plusBranch.indexOf('const trialOffer = await findPlusFreeTrialOffer(page);');
    const startNowIndex = plusBranch.indexOf('const startNow = await findPlusStartNowButton(page);');
    assert.ok(trialIndex >= 0, 'Plus 分支缺少 0 元试用检测');
    assert.ok(startNowIndex > trialIndex, '0 元试用检测必须先于点击升级按钮');
    assert.match(plusBranch, /error\.code = 'PLUS_FREE_TRIAL_ACCOUNT'/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Pro 0 元试用继续开通：允许 0 元金额与 Claim free offer 按钮', async () => {
  const applied = patch.toString();
  assert.match(applied, /function readMoneyCents\(text, currency, monthly = false, \{ allowZero = false \} = \{\}\)/);
  assert.match(applied, /return amount > 0 \|\| allowZero \? amount : null;/);
  assert.match(applied, /function readZeroMonthlyAmount\(text, currency\)/);
  assert.match(applied, /async function readProMonthlyAmount\(card, currency, \{ allowZero = false \} = \{\}\)/);
  // Pro 开通按钮接受 0 元试用的 CTA，Plus 的拒绝文案不得被 Pro 复用。
  assert.match(applied, /const PRO_ACTION_PATTERN = \/\^\(\?:立即体验\|Start now\|升级至\\s\*Pro\|Upgrade to Pro\|Get Pro\|Claim\\s\+\(\?:your\\s\+\)\?free\\s\+offer\|Claim\\s\+offer\)\$\/i;/);
  assert.match(applied, /if \(amount === 0\) console\.log\(`ℹ️ \[步骤\] Pro \$\{tier\} 显示 0 元试用，按正常开通继续`\);/);
  // 结账页金额核对在 0 元时跳过，其余档位与金额核对保持不变。
  assert.match(applied, /if \(amount === 0\) \{\n\+        console\.log\(`✅ \[步骤\] 已核对 Pro \$\{tier\} 结账档位（0 元试用，继续开通）`\);\n\+        return;\n\+    \}/);
});

test('准备脚本已接入 0 元试用补丁且保持全量核验', async () => {
  const prepare = (await readFile(prepareUrl, 'utf8')).replace(/\r\n/g, '\n');
  assert.match(prepare, /const plusTrialFiles = \['pricing-checkout\.js'\];/);
  assert.match(prepare, /async function approvedPlusTrial\(routing\)/);
  assert.match(prepare, /plusTrialFiles\.some\(name => manifest\.files\[name\]\.original !== routing\.files\[name\]\?\.approved\)/);
  assert.match(prepare, /throw new Error\('0 元试用补丁基准不符：' \+ name\)/);
  assert.match(prepare, /const expected = plusTrialFile\?\.approved \|\| afterCardPlans;/);
  assert.match(prepare, /plusTrialPatchSha256: plusTrial\.patchSha256/);
});

test('清单篡改会被拒绝', () => {
  const tampered = structuredClone(manifest);
  tampered.files['pricing-checkout.js'].approved = '0'.repeat(40);
  tampered.patchSha256 = createHash('sha256').update(patch.toString() + 'x').digest('hex');
  const accepted = tampered.revision === manifest.revision
    && JSON.stringify(Object.keys(tampered.files)) === JSON.stringify(['pricing-checkout.js'])
    && createHash('sha256').update(patch).digest('hex') === tampered.patchSha256;
  assert.equal(accepted, false);
});
