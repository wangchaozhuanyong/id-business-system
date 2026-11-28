import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sourceRoot = resolve(projectRoot, '.upstream/codexdaichong');
const runtimeRoot = resolve(projectRoot, '.runtime');

export const CODEXDAICHONG_REVISION = '4e9bb201cf481d4bcc85da34970fc26c63ab818a';
export const PRODUCTION_GUARD_REVISION = '3';
const routingDirectory = new URL('./routing/', import.meta.url);
const routingFiles = ['pricing-checkout.js', 'region-config.js', 'server.js'];
const providerRetirementPatch = new URL('./provider-retirement/upstream-provider-retirement.patch', import.meta.url);
const providerRetirementFiles = ['mysql-store.js', 'server.js'];
const cardPlanPatch = new URL('./card-plans/upstream-card-plans.patch', import.meta.url);
const cardPlanFiles = ['mysql-store.js', 'payment-retry.js', 'server.js'];
const plusTrialPatch = new URL('./plus-trial/upstream-plus-trial.patch', import.meta.url);
const retryPatch = new URL('./retry/upstream-retry.patch', import.meta.url);
const retryFiles = ['server.js'];
const plusTrialFiles = ['browser-pool.js', 'chatgpt.js', 'pricing-checkout.js', 'session-auth.js', 'stripe-payment.js'];
const proCardPatch = new URL('./pro-card/upstream-pro-card.patch', import.meta.url);
const proCardFiles = ['pricing-checkout.js'];
const retryPolicyPatch = new URL('./retry-policy/upstream-retry-policy.patch', import.meta.url);
const retryPolicyFiles = ['server.js'];
const sessionRestorePatch = new URL('./session-restore/upstream-session-restore.patch', import.meta.url);
const sessionRestoreFiles = ['session-auth.js'];
const debugFillPatch = new URL('./debug-fill/upstream-debug-fill.patch', import.meta.url);
const debugFillFiles = ['server.js'];
const regionJpPatch = new URL('./region-jp/upstream-region-jp.patch', import.meta.url);
const regionJpFiles = ['region-config.js'];
const sessionResetPatch = new URL('./session-reset/upstream-session-reset.patch', import.meta.url);
const sessionResetFiles = ['session-auth.js'];
const proxyProbePatch = new URL('./proxy-probe/upstream-proxy-probe.patch', import.meta.url);
const proxyProbeFiles = ['index.js'];
const poolLockCleanPatch = new URL('./pool-lock-clean/upstream-pool-lock-clean.patch', import.meta.url);
const poolLockCleanFiles = ['browser-pool.js'];
const spaDiagPatch = new URL('./spa-diag/upstream-spa-diag.patch', import.meta.url);
const spaDiagFiles = ['index.js'];
const proxyProbe2Patch = new URL('./proxy-probe2/upstream-proxy-probe2.patch', import.meta.url);
const proxyProbe2Files = ['index.js'];
const logoutGuardPatch = new URL('./logout-guard/upstream-logout-guard.patch', import.meta.url);
const logoutGuardFiles = ['pricing-checkout.js'];
const pricingVerifyPatch = new URL('./pricing-verify/upstream-pricing-verify.patch', import.meta.url);
const pricingVerifyFiles = ['pricing-checkout.js'];
const bearerFixPatch = new URL('./bearer-fix/upstream-bearer-fix.patch', import.meta.url);
const bearerFixFiles = ['pricing-checkout.js', 'session-auth.js'];
const deviceCookiePatch = new URL('./device-cookie/upstream-device-cookie.patch', import.meta.url);
const deviceCookieFiles = ['session-auth.js'];
const billingTunePatch = new URL('./billing-tune/upstream-billing-tune.patch', import.meta.url);
const billingTuneFiles = ['stripe-payment.js'];
const cityFixPatch = new URL('./city-fix/upstream-city-fix.patch', import.meta.url);
const cityFixFiles = ['stripe-payment.js'];
const regionSessionMatchPatch = new URL('./region-session-match/upstream-region-session-match.patch', import.meta.url);
const regionSessionMatchFiles = ['server.js'];
const planNameOptionalPatch = new URL('./plan-name-optional/upstream-plan-name-optional.patch', import.meta.url);
const planNameOptionalFiles = ['server.js'];
const regionWarnOnlyPatch = new URL('./region-warn-only/upstream-region-warn-only.patch', import.meta.url);
const regionWarnOnlyFiles = ['server.js'];
const fingerprintAlignPatch = new URL('./fingerprint-align/upstream-fingerprint-align.patch', import.meta.url);
const fingerprintAlignFiles = ['index.js'];
const realSessionPatch = new URL('./real-session/upstream-real-session.patch', import.meta.url);
const realSessionFiles = ['session-auth.js'];
const formWaitPatch = new URL('./form-wait/upstream-form-wait.patch', import.meta.url);
const formWaitFiles = ['chatgpt.js'];
const selectConfirmPatch = new URL('./select-confirm/upstream-select-confirm.patch', import.meta.url);
const selectConfirmFiles = ['stripe-payment.js'];
const waitTunePatch = new URL('./wait-tune/upstream-wait-tune.patch', import.meta.url);
const waitTuneFiles = ['stripe-payment.js'];
const adminTextPatch = new URL('./admin-text/upstream-admin-text.patch', import.meta.url);
const adminTextFiles = ['public/admin.js'];
const pricingWaitProfilePatch = new URL('./pricing-wait-profile/upstream-pricing-wait-profile.patch', import.meta.url);
const pricingWaitProfileFiles = ['pricing-checkout.js'];
const msgLenGuardPatch = new URL('./msg-len-guard/upstream-msg-len-guard.patch', import.meta.url);
const msgLenGuardFiles = ['pricing-checkout.js'];
const waitAllModesPatch = new URL('./wait-all-modes/upstream-wait-all-modes.patch', import.meta.url);
const waitAllModesFiles = ['chatgpt.js'];
const unifyWaitPatch = new URL('./unify-wait/upstream-unify-wait.patch', import.meta.url);
const unifyWaitFiles = ['index.js'];
const msgFixPatch = new URL('./msg-fix/upstream-msg-fix.patch', import.meta.url);
const msgFixFiles = ['chatgpt.js', 'index.js', 'server.js'];
const msgFix2Patch = new URL('./msg-fix2/upstream-msg-fix2.patch', import.meta.url);
const msgFix2Files = ['chatgpt.js'];

async function approvedRouting() {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', routingDirectory), 'utf8'));
  const patch = await readFile(new URL('upstream-routing.patch', routingDirectory));
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(routingFiles) ||
      JSON.stringify(names) !== JSON.stringify(routingFiles) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('套餐选路补丁与审查清单不符');
  return manifest;
}

async function approvedReturns(routing) {
  const directory = new URL('./returns/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  const patch = await readFile(new URL('upstream-returns.patch', directory));
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  const files = ['mysql-store.js', 'server.js'];
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(files) ||
      JSON.stringify(names) !== JSON.stringify(files) ||
      manifest.files['server.js'].original !== routing.files['server.js'].approved ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('充值码归还补丁与审查清单不符');
  return manifest;
}

async function approvedProviderRetirement(returns) {
  const manifest = JSON.parse(await readFile(new URL('./provider-retirement/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(providerRetirementPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(providerRetirementFiles) ||
      JSON.stringify(names) !== JSON.stringify(providerRetirementFiles) ||
      providerRetirementFiles.some(name => manifest.files[name].original !== returns.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('第三方代充移除补丁与审查清单不符');
  return manifest;
}

async function approvedCardPlans(retirement) {
  const manifest = JSON.parse(await readFile(new URL('./card-plans/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(cardPlanPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(cardPlanFiles) ||
      JSON.stringify(names) !== JSON.stringify(cardPlanFiles) ||
      providerRetirementFiles.some(name => manifest.files[name].original !== retirement.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('银行卡套餐补丁与审查清单不符');
  return manifest;
}

async function approvedRetry(cardPlans) {
  const manifest = JSON.parse(await readFile(new URL('./retry/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(retryPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(retryFiles) ||
      JSON.stringify(names) !== JSON.stringify(retryFiles) ||
      // 重试补丁的基准就是银行卡套餐补丁应用后的 server.js
      manifest.files['server.js'].original !== cardPlans.files['server.js'].approved ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('失败重试补丁与审查清单不符');
  return manifest;
}

async function approvedPlusTrial(routing) {
  const manifest = JSON.parse(await readFile(new URL('./plus-trial/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(plusTrialPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(plusTrialFiles) ||
      JSON.stringify(names) !== JSON.stringify(plusTrialFiles) ||
      // stripe-payment.js 未被前序补丁修改，其基准就是锁定上游文件，由全量核验串联。
      plusTrialFiles.some(name => routing.files[name] && manifest.files[name].original !== routing.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('0 元试用补丁与审查清单不符');
  return manifest;
}

async function approvedSessionRestore(plusTrial) {
  const manifest = JSON.parse(await readFile(new URL('./session-restore/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(sessionRestorePatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(sessionRestoreFiles) ||
      JSON.stringify(names) !== JSON.stringify(sessionRestoreFiles) ||
      sessionRestoreFiles.some(name => plusTrial.files[name] && manifest.files[name].original !== plusTrial.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('会话校验恢复补丁与审查清单不符');
  return manifest;
}

async function approvedProCard(plusTrial) {
  const manifest = JSON.parse(await readFile(new URL('./pro-card/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(proCardPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(proCardFiles) ||
      JSON.stringify(names) !== JSON.stringify(proCardFiles) ||
      // 它的基准就是 plus-trial 的产物
      proCardFiles.some(name => plusTrial.files[name] && manifest.files[name].original !== plusTrial.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('定价页 Pro 卡片补丁与审查清单不符');
  return manifest;
}

async function approvedRetryPolicy(retry) {
  const manifest = JSON.parse(await readFile(new URL('./retry-policy/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(retryPolicyPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(retryPolicyFiles) ||
      JSON.stringify(names) !== JSON.stringify(retryPolicyFiles) ||
      retryPolicyFiles.some(name => retry.files[name] && manifest.files[name].original !== retry.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('重试策略补丁与审查清单不符');
  return manifest;
}

async function approvedDebugFill(retryPolicy) {
  const manifest = JSON.parse(await readFile(new URL('./debug-fill/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(debugFillPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(debugFillFiles) ||
      JSON.stringify(names) !== JSON.stringify(debugFillFiles) ||
      debugFillFiles.some(name => retryPolicy.files[name] && manifest.files[name].original !== retryPolicy.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('调试填卡补丁与审查清单不符');
  return manifest;
}

async function approvedRegionJp(routing) {
  const manifest = JSON.parse(await readFile(new URL('./region-jp/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(regionJpPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(regionJpFiles) ||
      JSON.stringify(names) !== JSON.stringify(regionJpFiles) ||
      regionJpFiles.some(name => routing.files[name] && manifest.files[name].original !== routing.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('日本区补丁与审查清单不符');
  return manifest;
}

async function approvedSessionReset(sessionRestore) {
  const manifest = JSON.parse(await readFile(new URL('./session-reset/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(sessionResetPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(sessionResetFiles) ||
      JSON.stringify(names) !== JSON.stringify(sessionResetFiles) ||
      sessionResetFiles.some(name => sessionRestore.files[name] && manifest.files[name].original !== sessionRestore.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('会话 Cookie 清理补丁与审查清单不符');
  return manifest;
}

async function approvedProxyProbe(routing) {
  const manifest = JSON.parse(await readFile(new URL('./proxy-probe/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(proxyProbePatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(proxyProbeFiles) ||
      JSON.stringify(names) !== JSON.stringify(proxyProbeFiles) ||
      proxyProbeFiles.some(name => routing.files[name] && manifest.files[name].original !== routing.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('代理探测重试补丁与审查清单不符');
  return manifest;
}

async function approvedPoolLockClean(plusTrial) {
  const manifest = JSON.parse(await readFile(new URL('./pool-lock-clean/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(poolLockCleanPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(poolLockCleanFiles) ||
      JSON.stringify(names) !== JSON.stringify(poolLockCleanFiles) ||
      poolLockCleanFiles.some(name => plusTrial.files[name] && manifest.files[name].original !== plusTrial.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('浏览器池锁清理补丁与审查清单不符');
  return manifest;
}

async function approvedSpaDiag(proxyProbe) {
  const manifest = JSON.parse(await readFile(new URL('./spa-diag/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(spaDiagPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(spaDiagFiles) ||
      JSON.stringify(names) !== JSON.stringify(spaDiagFiles) ||
      spaDiagFiles.some(name => proxyProbe.files[name] && manifest.files[name].original !== proxyProbe.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('页面建单诊断补丁与审查清单不符');
  return manifest;
}

async function approvedProxyProbe2(spaDiag) {
  const manifest = JSON.parse(await readFile(new URL('./proxy-probe2/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(proxyProbe2Patch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(proxyProbe2Files) ||
      JSON.stringify(names) !== JSON.stringify(proxyProbe2Files) ||
      proxyProbe2Files.some(name => spaDiag.files[name] && manifest.files[name].original !== spaDiag.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('代理探测 HTTPS 补丁与审查清单不符');
  return manifest;
}

async function approvedLogoutGuard(proCard) {
  const manifest = JSON.parse(await readFile(new URL('./logout-guard/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(logoutGuardPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(logoutGuardFiles) ||
      JSON.stringify(names) !== JSON.stringify(logoutGuardFiles) ||
      logoutGuardFiles.some(name => proCard.files[name] && manifest.files[name].original !== proCard.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('登出防护补丁与审查清单不符');
  return manifest;
}

async function approvedPricingVerify(logoutGuard) {
  const manifest = JSON.parse(await readFile(new URL('./pricing-verify/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(pricingVerifyPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(pricingVerifyFiles) ||
      JSON.stringify(names) !== JSON.stringify(pricingVerifyFiles) ||
      pricingVerifyFiles.some(name => logoutGuard.files[name] && manifest.files[name].original !== logoutGuard.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('定价页校验补丁与审查清单不符');
  return manifest;
}

async function approvedBearerFix(pricingVerify, sessionReset) {
  const manifest = JSON.parse(await readFile(new URL('./bearer-fix/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(bearerFixPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  const base = { 'pricing-checkout.js': pricingVerify, 'session-auth.js': sessionReset };
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(bearerFixFiles) ||
      JSON.stringify(names) !== JSON.stringify(bearerFixFiles) ||
      bearerFixFiles.some(name => manifest.files[name].original !== base[name].files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('Bearer 收窄补丁与审查清单不符');
  return manifest;
}

async function approvedDeviceCookie(bearerFix) {
  const manifest = JSON.parse(await readFile(new URL('./device-cookie/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(deviceCookiePatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(deviceCookieFiles) ||
      JSON.stringify(names) !== JSON.stringify(deviceCookieFiles) ||
      deviceCookieFiles.some(name => bearerFix.files[name] && manifest.files[name].original !== bearerFix.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('设备指纹补丁与审查清单不符');
  return manifest;
}

async function approvedBillingTune(plusTrial) {
  const manifest = JSON.parse(await readFile(new URL('./billing-tune/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(billingTunePatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(billingTuneFiles) ||
      JSON.stringify(names) !== JSON.stringify(billingTuneFiles) ||
      billingTuneFiles.some(name => plusTrial.files[name] && manifest.files[name].original !== plusTrial.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('账单填写调优补丁与审查清单不符');
  return manifest;
}

async function approvedCityFix(billingTune) {
  const manifest = JSON.parse(await readFile(new URL('./city-fix/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(cityFixPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(cityFixFiles) ||
      JSON.stringify(names) !== JSON.stringify(cityFixFiles) ||
      cityFixFiles.some(name => billingTune.files[name] && manifest.files[name].original !== billingTune.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('城市必填补丁与审查清单不符');
  return manifest;
}

async function approvedRegionSessionMatch(debugFill) {
  const manifest = JSON.parse(await readFile(new URL('./region-session-match/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(regionSessionMatchPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(regionSessionMatchFiles) ||
      JSON.stringify(names) !== JSON.stringify(regionSessionMatchFiles) ||
      regionSessionMatchFiles.some(name => debugFill.files[name] && manifest.files[name].original !== debugFill.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('地区一致性补丁与审查清单不符');
  return manifest;
}

async function approvedPlanNameOptional(regionSessionMatch) {
  const manifest = JSON.parse(await readFile(new URL('./plan-name-optional/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(planNameOptionalPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(planNameOptionalFiles) ||
      JSON.stringify(names) !== JSON.stringify(planNameOptionalFiles) ||
      planNameOptionalFiles.some(name => regionSessionMatch.files[name] && manifest.files[name].original !== regionSessionMatch.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('plan_name 可选补丁与审查清单不符');
  return manifest;
}

async function approvedRegionWarnOnly(planNameOptional) {
  const manifest = JSON.parse(await readFile(new URL('./region-warn-only/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(regionWarnOnlyPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(regionWarnOnlyFiles) ||
      JSON.stringify(names) !== JSON.stringify(regionWarnOnlyFiles) ||
      regionWarnOnlyFiles.some(name => planNameOptional.files[name] && manifest.files[name].original !== planNameOptional.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('地区告警补丁与审查清单不符');
  return manifest;
}

async function approvedFingerprintAlign(proxyProbe2) {
  const manifest = JSON.parse(await readFile(new URL('./fingerprint-align/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(fingerprintAlignPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(fingerprintAlignFiles) ||
      JSON.stringify(names) !== JSON.stringify(fingerprintAlignFiles) ||
      fingerprintAlignFiles.some(name => proxyProbe2.files[name] && manifest.files[name].original !== proxyProbe2.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('指纹对齐补丁与审查清单不符');
  return manifest;
}

async function approvedRealSession(deviceCookie) {
  const manifest = JSON.parse(await readFile(new URL('./real-session/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(realSessionPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(realSessionFiles) ||
      JSON.stringify(names) !== JSON.stringify(realSessionFiles) ||
      realSessionFiles.some(name => deviceCookie.files[name] && manifest.files[name].original !== deviceCookie.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('真实会话放行补丁与审查清单不符');
  return manifest;
}

async function approvedFormWait(realSession) {
  const manifest = JSON.parse(await readFile(new URL('./form-wait/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(formWaitPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(formWaitFiles) ||
      JSON.stringify(names) !== JSON.stringify(formWaitFiles) ||
      formWaitFiles.some(name => realSession.files[name] && manifest.files[name].original !== realSession.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('表单等待补丁与审查清单不符');
  return manifest;
}

async function approvedSelectConfirm(cityFix) {
  const manifest = JSON.parse(await readFile(new URL('./select-confirm/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(selectConfirmPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(selectConfirmFiles) ||
      JSON.stringify(names) !== JSON.stringify(selectConfirmFiles) ||
      selectConfirmFiles.some(name => cityFix.files[name] && manifest.files[name].original !== cityFix.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('下拉确认补丁与审查清单不符');
  return manifest;
}

async function approvedMsgFix(bases) {
  const manifest = JSON.parse(await readFile(new URL('./msg-fix/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(msgFixPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(msgFixFiles) ||
      JSON.stringify(names) !== JSON.stringify(msgFixFiles) ||
      msgFixFiles.some(name => bases[name] && manifest.files[name].original !== bases[name]) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('文案修正补丁与审查清单不符');
  return manifest;
}

async function approvedMsgFix2(msgFix) {
  const manifest = JSON.parse(await readFile(new URL('./msg-fix2/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(msgFix2Patch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(msgFix2Files) ||
      JSON.stringify(names) !== JSON.stringify(msgFix2Files) ||
      msgFix2Files.some(name => msgFix.files[name] && manifest.files[name].original !== msgFix.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('文案修正补丁二与审查清单不符');
  return manifest;
}

async function approvedWaitTune(selectConfirm) {
  const manifest = JSON.parse(await readFile(new URL('./wait-tune/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(waitTunePatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(waitTuneFiles) ||
      JSON.stringify(names) !== JSON.stringify(waitTuneFiles) ||
      waitTuneFiles.some(name => selectConfirm.files[name] && manifest.files[name].original !== selectConfirm.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('等待调优补丁与审查清单不符');
  return manifest;
}

async function approvedAdminText() {
  const manifest = JSON.parse(await readFile(new URL('./admin-text/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(adminTextPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(adminTextFiles) ||
      JSON.stringify(names) !== JSON.stringify(adminTextFiles) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('前端文案补丁与审查清单不符');
  return manifest;
}

async function approvedPricingWaitProfile(bearerFix) {
  const manifest = JSON.parse(await readFile(new URL('./pricing-wait-profile/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(pricingWaitProfilePatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(pricingWaitProfileFiles) ||
      JSON.stringify(names) !== JSON.stringify(pricingWaitProfileFiles) ||
      pricingWaitProfileFiles.some(name => bearerFix.files[name] && manifest.files[name].original !== bearerFix.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('定价页等待补丁与审查清单不符');
  return manifest;
}

async function approvedMsgLenGuard(pricingWaitProfile) {
  const manifest = JSON.parse(await readFile(new URL('./msg-len-guard/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(msgLenGuardPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(msgLenGuardFiles) ||
      JSON.stringify(names) !== JSON.stringify(msgLenGuardFiles) ||
      msgLenGuardFiles.some(name => pricingWaitProfile.files[name] && manifest.files[name].original !== pricingWaitProfile.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('日志长度保护补丁与审查清单不符');
  return manifest;
}

async function approvedWaitAllModes(msgFix2) {
  const manifest = JSON.parse(await readFile(new URL('./wait-all-modes/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(waitAllModesPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(waitAllModesFiles) ||
      JSON.stringify(names) !== JSON.stringify(waitAllModesFiles) ||
      waitAllModesFiles.some(name => msgFix2.files[name] && manifest.files[name].original !== msgFix2.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('全模式等待补丁与审查清单不符');
  return manifest;
}

async function approvedUnifyWait(msgFix) {
  const manifest = JSON.parse(await readFile(new URL('./unify-wait/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(unifyWaitPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(unifyWaitFiles) ||
      JSON.stringify(names) !== JSON.stringify(unifyWaitFiles) ||
      unifyWaitFiles.some(name => msgFix.files[name] && manifest.files[name].original !== msgFix.files[name].approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('统一等待补丁与审查清单不符');
  return manifest;
}

async function verifyPatchPreimage(directory, manifest) {
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = resolve(directory, name), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('补丁输入文件类型不符：' + name);
    const content = await readFile(file);
    const hash = createHash('sha1').update('blob ' + content.length + '\0').update(content).digest('hex');
    if (hash !== expected.original) throw new Error('补丁输入源码不符：' + name);
  }
}

/** Apply only the manifest-verified recharge patches to the copy. */
export async function applyApprovedRechargeRouting(directory) {
  const routing = await approvedRouting();
  const returnManifest = await approvedReturns(routing);
  const retirement = await approvedProviderRetirement(returnManifest);
  const cardPlans = await approvedCardPlans(retirement);
  const plusTrial = await approvedPlusTrial(routing);
  const args = ['--git-dir=' + resolve(sourceRoot, '.git'), '--work-tree=' + await realpath(directory),
    'apply'];
  const patch = fileURLToPath(new URL('upstream-routing.patch', routingDirectory));
  // git apply is constrained by the checked manifest and never touches the upstream index.
  await exec('git', [...args, '--check', patch], { cwd: directory });
  await exec('git', [...args, patch], { cwd: directory });
  const returns = fileURLToPath(new URL('./returns/upstream-returns.patch', import.meta.url));
  // Zero-context insertion patches still require the exact complete preimage for both files.
  await verifyPatchPreimage(directory, returnManifest);
  await exec('git', [...args, '--unidiff-zero', '--check', returns], { cwd: directory });
  await exec('git', [...args, '--unidiff-zero', returns], { cwd: directory });
  await verifyPatchPreimage(directory, retirement);
  const retirementPath = fileURLToPath(providerRetirementPatch);
  await exec('git', [...args, '--check', retirementPath], { cwd: directory });
  await exec('git', [...args, retirementPath], { cwd: directory });
  await verifyPatchPreimage(directory, cardPlans);
  const cardPlanPath = fileURLToPath(cardPlanPatch);
  await exec('git', [...args, '--check', cardPlanPath], { cwd: directory });
  await exec('git', [...args, cardPlanPath], { cwd: directory });
  await verifyPatchPreimage(directory, plusTrial);
  const plusTrialPath = fileURLToPath(plusTrialPatch);
  await exec('git', [...args, '--check', plusTrialPath], { cwd: directory });
  await exec('git', [...args, plusTrialPath], { cwd: directory });
  const sessionRestore = await approvedSessionRestore(plusTrial);
  await verifyPatchPreimage(directory, sessionRestore);
  const sessionRestorePath = fileURLToPath(sessionRestorePatch);
  await exec('git', [...args, '--check', sessionRestorePath], { cwd: directory });
  await exec('git', [...args, sessionRestorePath], { cwd: directory });
  const proCard = await approvedProCard(plusTrial);
  await verifyPatchPreimage(directory, proCard);
  const proCardPath = fileURLToPath(proCardPatch);
  await exec('git', [...args, '--check', proCardPath], { cwd: directory });
  await exec('git', [...args, proCardPath], { cwd: directory });
  const retry = await approvedRetry(cardPlans);
  await verifyPatchPreimage(directory, retry);
  const retryPath = fileURLToPath(retryPatch);
  await exec('git', [...args, '--check', retryPath], { cwd: directory });
  await exec('git', [...args, retryPath], { cwd: directory });
  const retryPolicy = await approvedRetryPolicy(retry);
  await verifyPatchPreimage(directory, retryPolicy);
  const retryPolicyPath = fileURLToPath(retryPolicyPatch);
  await exec('git', [...args, '--check', retryPolicyPath], { cwd: directory });
  await exec('git', [...args, retryPolicyPath], { cwd: directory });
  const debugFill = await approvedDebugFill(retryPolicy);
  await verifyPatchPreimage(directory, debugFill);
  const debugFillPath = fileURLToPath(debugFillPatch);
  await exec('git', [...args, '--check', debugFillPath], { cwd: directory });
  await exec('git', [...args, debugFillPath], { cwd: directory });
  const regionJp = await approvedRegionJp(routing);
  await verifyPatchPreimage(directory, regionJp);
  const regionJpPath = fileURLToPath(regionJpPatch);
  await exec('git', [...args, '--check', regionJpPath], { cwd: directory });
  await exec('git', [...args, regionJpPath], { cwd: directory });
  const sessionReset = await approvedSessionReset(sessionRestore);
  await verifyPatchPreimage(directory, sessionReset);
  const sessionResetPath = fileURLToPath(sessionResetPatch);
  await exec('git', [...args, '--check', sessionResetPath], { cwd: directory });
  await exec('git', [...args, sessionResetPath], { cwd: directory });
  const proxyProbe = await approvedProxyProbe(routing);
  await verifyPatchPreimage(directory, proxyProbe);
  const proxyProbePath = fileURLToPath(proxyProbePatch);
  await exec('git', [...args, '--check', proxyProbePath], { cwd: directory });
  await exec('git', [...args, proxyProbePath], { cwd: directory });
  const poolLockClean = await approvedPoolLockClean(plusTrial);
  await verifyPatchPreimage(directory, poolLockClean);
  const poolLockCleanPath = fileURLToPath(poolLockCleanPatch);
  await exec('git', [...args, '--check', poolLockCleanPath], { cwd: directory });
  await exec('git', [...args, poolLockCleanPath], { cwd: directory });
  const spaDiag = await approvedSpaDiag(proxyProbe);
  await verifyPatchPreimage(directory, spaDiag);
  const spaDiagPath = fileURLToPath(spaDiagPatch);
  await exec('git', [...args, '--check', spaDiagPath], { cwd: directory });
  await exec('git', [...args, spaDiagPath], { cwd: directory });
  const proxyProbe2 = await approvedProxyProbe2(spaDiag);
  await verifyPatchPreimage(directory, proxyProbe2);
  const proxyProbe2Path = fileURLToPath(proxyProbe2Patch);
  await exec('git', [...args, '--check', proxyProbe2Path], { cwd: directory });
  await exec('git', [...args, proxyProbe2Path], { cwd: directory });
  const logoutGuard = await approvedLogoutGuard(proCard);
  await verifyPatchPreimage(directory, logoutGuard);
  const logoutGuardPath = fileURLToPath(logoutGuardPatch);
  await exec('git', [...args, '--check', logoutGuardPath], { cwd: directory });
  await exec('git', [...args, logoutGuardPath], { cwd: directory });
  const pricingVerify = await approvedPricingVerify(logoutGuard);
  await verifyPatchPreimage(directory, pricingVerify);
  const pricingVerifyPath = fileURLToPath(pricingVerifyPatch);
  await exec('git', [...args, '--check', pricingVerifyPath], { cwd: directory });
  await exec('git', [...args, pricingVerifyPath], { cwd: directory });
  const bearerFix = await approvedBearerFix(pricingVerify, sessionReset);
  await verifyPatchPreimage(directory, bearerFix);
  const bearerFixPath = fileURLToPath(bearerFixPatch);
  await exec('git', [...args, '--check', bearerFixPath], { cwd: directory });
  await exec('git', [...args, bearerFixPath], { cwd: directory });
  const deviceCookie = await approvedDeviceCookie(bearerFix);
  await verifyPatchPreimage(directory, deviceCookie);
  const deviceCookiePath = fileURLToPath(deviceCookiePatch);
  await exec('git', [...args, '--check', deviceCookiePath], { cwd: directory });
  await exec('git', [...args, deviceCookiePath], { cwd: directory });
  const billingTune = await approvedBillingTune(plusTrial);
  await verifyPatchPreimage(directory, billingTune);
  const billingTunePath = fileURLToPath(billingTunePatch);
  await exec('git', [...args, '--check', billingTunePath], { cwd: directory });
  await exec('git', [...args, billingTunePath], { cwd: directory });
  const cityFix = await approvedCityFix(billingTune);
  await verifyPatchPreimage(directory, cityFix);
  const cityFixPath = fileURLToPath(cityFixPatch);
  await exec('git', [...args, '--check', cityFixPath], { cwd: directory });
  await exec('git', [...args, cityFixPath], { cwd: directory });
  const regionSessionMatch = await approvedRegionSessionMatch(debugFill);
  await verifyPatchPreimage(directory, regionSessionMatch);
  const regionSessionMatchPath = fileURLToPath(regionSessionMatchPatch);
  await exec('git', [...args, '--check', regionSessionMatchPath], { cwd: directory });
  await exec('git', [...args, regionSessionMatchPath], { cwd: directory });
  const planNameOptional = await approvedPlanNameOptional(regionSessionMatch);
  await verifyPatchPreimage(directory, planNameOptional);
  const planNameOptionalPath = fileURLToPath(planNameOptionalPatch);
  await exec('git', [...args, '--check', planNameOptionalPath], { cwd: directory });
  await exec('git', [...args, planNameOptionalPath], { cwd: directory });
  const regionWarnOnly = await approvedRegionWarnOnly(planNameOptional);
  await verifyPatchPreimage(directory, regionWarnOnly);
  const regionWarnOnlyPath = fileURLToPath(regionWarnOnlyPatch);
  await exec('git', [...args, '--check', regionWarnOnlyPath], { cwd: directory });
  await exec('git', [...args, regionWarnOnlyPath], { cwd: directory });
  const fingerprintAlign = await approvedFingerprintAlign(proxyProbe2);
  await verifyPatchPreimage(directory, fingerprintAlign);
  const fingerprintAlignPath = fileURLToPath(fingerprintAlignPatch);
  await exec('git', [...args, '--check', fingerprintAlignPath], { cwd: directory });
  await exec('git', [...args, fingerprintAlignPath], { cwd: directory });
  const realSession = await approvedRealSession(deviceCookie);
  await verifyPatchPreimage(directory, realSession);
  const realSessionPath = fileURLToPath(realSessionPatch);
  await exec('git', [...args, '--check', realSessionPath], { cwd: directory });
  await exec('git', [...args, realSessionPath], { cwd: directory });
  const formWait = await approvedFormWait(realSession);
  await verifyPatchPreimage(directory, formWait);
  const formWaitPath = fileURLToPath(formWaitPatch);
  await exec('git', [...args, '--check', formWaitPath], { cwd: directory });
  await exec('git', [...args, formWaitPath], { cwd: directory });
  const selectConfirm = await approvedSelectConfirm(cityFix);
  await verifyPatchPreimage(directory, selectConfirm);
  const selectConfirmPath = fileURLToPath(selectConfirmPatch);
  await exec('git', [...args, '--check', selectConfirmPath], { cwd: directory });
  await exec('git', [...args, selectConfirmPath], { cwd: directory });
  const msgFixBases = {
    'chatgpt.js': formWait.files['chatgpt.js'] && formWait.files['chatgpt.js'].approved,
    'index.js': fingerprintAlign.files['index.js'] && fingerprintAlign.files['index.js'].approved,
    'server.js': regionWarnOnly.files['server.js'] && regionWarnOnly.files['server.js'].approved,
    'stripe-payment.js': selectConfirm.files['stripe-payment.js'] && selectConfirm.files['stripe-payment.js'].approved
  };
  const msgFix = await approvedMsgFix(msgFixBases);
  await verifyPatchPreimage(directory, msgFix);
  const msgFixPath = fileURLToPath(msgFixPatch);
  await exec('git', [...args, '--check', msgFixPath], { cwd: directory });
  await exec('git', [...args, msgFixPath], { cwd: directory });
  const msgFix2 = await approvedMsgFix2(msgFix);
  await verifyPatchPreimage(directory, msgFix2);
  const msgFix2Path = fileURLToPath(msgFix2Patch);
  await exec('git', [...args, '--check', msgFix2Path], { cwd: directory });
  await exec('git', [...args, msgFix2Path], { cwd: directory });
  const waitTune = await approvedWaitTune(selectConfirm);
  await verifyPatchPreimage(directory, waitTune);
  const waitTunePath = fileURLToPath(waitTunePatch);
  await exec('git', [...args, '--check', waitTunePath], { cwd: directory });
  await exec('git', [...args, waitTunePath], { cwd: directory });
  const adminText = await approvedAdminText();
  await verifyPatchPreimage(directory, adminText);
  const adminTextPath = fileURLToPath(adminTextPatch);
  await exec('git', [...args, '--check', adminTextPath], { cwd: directory });
  await exec('git', [...args, adminTextPath], { cwd: directory });
  const pricingWaitProfile = await approvedPricingWaitProfile(bearerFix);
  await verifyPatchPreimage(directory, pricingWaitProfile);
  const pricingWaitProfilePath = fileURLToPath(pricingWaitProfilePatch);
  await exec('git', [...args, '--check', pricingWaitProfilePath], { cwd: directory });
  await exec('git', [...args, pricingWaitProfilePath], { cwd: directory });
  const msgLenGuard = await approvedMsgLenGuard(pricingWaitProfile);
  await verifyPatchPreimage(directory, msgLenGuard);
  const msgLenGuardPath = fileURLToPath(msgLenGuardPatch);
  await exec('git', [...args, '--check', msgLenGuardPath], { cwd: directory });
  await exec('git', [...args, msgLenGuardPath], { cwd: directory });
  const waitAllModes = await approvedWaitAllModes(msgFix2);
  await verifyPatchPreimage(directory, waitAllModes);
  const waitAllModesPath = fileURLToPath(waitAllModesPatch);
  await exec('git', [...args, '--check', waitAllModesPath], { cwd: directory });
  await exec('git', [...args, waitAllModesPath], { cwd: directory });
  const unifyWait = await approvedUnifyWait(msgFix);
  await verifyPatchPreimage(directory, unifyWait);
  const unifyWaitPath = fileURLToPath(unifyWaitPatch);
  await exec('git', [...args, '--check', unifyWaitPath], { cwd: directory });
  await exec('git', [...args, unifyWaitPath], { cwd: directory });
}

function isDescendant(base, target) {
  const path = relative(base, target);
  return path !== '' && path !== '..' && !path.startsWith('../') && !isAbsolute(path);
}

async function extractPinnedSource(directory) {
  // tar may exit after its end marker before git's trailing padding drains into
  // stdin. A completed archive file makes extraction independent of pipe timing.
  const temporary = await mkdtemp(resolve(runtimeRoot, 'pinned-source-'));
  const archive = resolve(temporary, 'source.tar');
  try {
    await exec('git', ['-C', sourceRoot, 'archive', '--format=tar', '--output', archive, CODEXDAICHONG_REVISION]);
    await exec('tar', ['-xf', archive, '-C', directory]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Check every tracked upstream file, including the scheduler, store and dependency lock. */
export async function verifyCodexdaichongSource(directory) {
  const destination = await realpath(directory);
  const routing = await approvedRouting();
  const returns = await approvedReturns(routing);
  const retirement = await approvedProviderRetirement(returns);
  const cardPlans = await approvedCardPlans(retirement);
  const plusTrial = await approvedPlusTrial(routing);
  const sessionRestore = await approvedSessionRestore(plusTrial);
  const proCard = await approvedProCard(plusTrial);
  const retry = await approvedRetry(cardPlans);
  const retryPolicy = await approvedRetryPolicy(retry);
  const debugFill = await approvedDebugFill(retryPolicy);
  const regionJp = await approvedRegionJp(routing);
  const sessionReset = await approvedSessionReset(sessionRestore);
  const proxyProbe = await approvedProxyProbe(routing);
  const poolLockClean = await approvedPoolLockClean(plusTrial);
  const spaDiag = await approvedSpaDiag(proxyProbe);
  const proxyProbe2 = await approvedProxyProbe2(spaDiag);
  const logoutGuard = await approvedLogoutGuard(proCard);
  const pricingVerify = await approvedPricingVerify(logoutGuard);
  const bearerFix = await approvedBearerFix(pricingVerify, sessionReset);
  const deviceCookie = await approvedDeviceCookie(bearerFix);
  const billingTune = await approvedBillingTune(plusTrial);
  const cityFix = await approvedCityFix(billingTune);
  const regionSessionMatch = await approvedRegionSessionMatch(debugFill);
  const planNameOptional = await approvedPlanNameOptional(regionSessionMatch);
  const regionWarnOnly = await approvedRegionWarnOnly(planNameOptional);
  const fingerprintAlign = await approvedFingerprintAlign(proxyProbe2);
  const realSession = await approvedRealSession(deviceCookie);
  const formWait = await approvedFormWait(realSession);
  const selectConfirm = await approvedSelectConfirm(cityFix);
  const msgFixBases = {
    'chatgpt.js': formWait.files['chatgpt.js'] && formWait.files['chatgpt.js'].approved,
    'index.js': fingerprintAlign.files['index.js'] && fingerprintAlign.files['index.js'].approved,
    'server.js': regionWarnOnly.files['server.js'] && regionWarnOnly.files['server.js'].approved,
    'stripe-payment.js': selectConfirm.files['stripe-payment.js'] && selectConfirm.files['stripe-payment.js'].approved
  };
  const msgFix = await approvedMsgFix(msgFixBases);
  const msgFix2 = await approvedMsgFix2(msgFix);
  const waitTune = await approvedWaitTune(selectConfirm);
  const adminText = await approvedAdminText();
  const pricingWaitProfile = await approvedPricingWaitProfile(bearerFix);
  const msgLenGuard = await approvedMsgLenGuard(pricingWaitProfile);
  const waitAllModes = await approvedWaitAllModes(msgFix2);
  const unifyWait = await approvedUnifyWait(msgFix);
  const { stdout } = await exec('git', ['-C', sourceRoot, 'ls-tree', '-rz', CODEXDAICHONG_REVISION], {
    maxBuffer: 8 * 1024 * 1024
  });
  let files = 0;
  for (const entry of stdout.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\t');
    const [mode, type, original] = entry.slice(0, separator).split(' ');
    const name = entry.slice(separator + 1);
    const approved = routing.files[name];
    if (approved && approved.original !== original) throw new Error('选路补丁基准不符：' + name);
    const returnFile = returns.files[name];
    if (returnFile && returnFile.original !== (approved?.approved || original))
      throw new Error('归还补丁基准不符：' + name);
    const previous = retirement.files[name]?.approved || returnFile?.approved || approved?.approved || original;
    const cardPlan = cardPlans.files[name];
    if (cardPlan && cardPlan.original !== previous) throw new Error('银行卡套餐补丁基准不符：' + name);
    const afterCardPlans = cardPlan?.approved || previous;
    const plusTrialFile = plusTrial.files[name];
    if (plusTrialFile && plusTrialFile.original !== afterCardPlans) throw new Error('0 元试用补丁基准不符：' + name);
    const afterPlusTrial = plusTrialFile?.approved || afterCardPlans;
    const sessionRestoreFile = sessionRestore.files[name];
    if (sessionRestoreFile && sessionRestoreFile.original !== afterPlusTrial) throw new Error('会话校验恢复补丁基准不符：' + name);
    const afterSessionRestore = sessionRestoreFile?.approved || afterPlusTrial;
    const proCardFile = proCard.files[name];
    if (proCardFile && proCardFile.original !== afterSessionRestore) throw new Error('Pro 卡片补丁基准不符：' + name);
    const afterProCard = proCardFile?.approved || afterSessionRestore;
    const retryFile = retry.files[name];
    if (retryFile && retryFile.original !== afterProCard) throw new Error('失败重试补丁基准不符：' + name);
    const afterRetry = retryFile?.approved || afterProCard;
    const retryPolicyFile = retryPolicy.files[name];
    if (retryPolicyFile && retryPolicyFile.original !== afterRetry) throw new Error('重试策略补丁基准不符：' + name);
    const afterRetryPolicy = retryPolicyFile?.approved || afterRetry;
    const debugFillFile = debugFill.files[name];
    if (debugFillFile && debugFillFile.original !== afterRetryPolicy) throw new Error('调试填卡补丁基准不符：' + name);
    const afterDebugFill = debugFillFile?.approved || afterRetryPolicy;
    const regionJpFile = regionJp.files[name];
    if (regionJpFile && regionJpFile.original !== afterDebugFill) throw new Error('日本区补丁基准不符：' + name);
    const afterRegionJp = regionJpFile?.approved || afterDebugFill;
    const sessionResetFile = sessionReset.files[name];
    if (sessionResetFile && sessionResetFile.original !== afterRegionJp) throw new Error('会话 Cookie 清理补丁基准不符：' + name);
    const afterSessionReset = sessionResetFile?.approved || afterRegionJp;
    const proxyProbeFile = proxyProbe.files[name];
    if (proxyProbeFile && proxyProbeFile.original !== afterSessionReset) throw new Error('代理探测重试补丁基准不符：' + name);
    const afterProxyProbe = proxyProbeFile?.approved || afterSessionReset;
    const poolLockCleanFile = poolLockClean.files[name];
    if (poolLockCleanFile && poolLockCleanFile.original !== afterProxyProbe) throw new Error('浏览器池锁清理补丁基准不符：' + name);
    const afterPoolLockClean = poolLockCleanFile?.approved || afterProxyProbe;
    const spaDiagFile = spaDiag.files[name];
    if (spaDiagFile && spaDiagFile.original !== afterPoolLockClean) throw new Error('页面建单诊断补丁基准不符：' + name);
    const afterSpaDiag = spaDiagFile?.approved || afterPoolLockClean;
    const proxyProbe2File = proxyProbe2.files[name];
    if (proxyProbe2File && proxyProbe2File.original !== afterSpaDiag) throw new Error('代理探测 HTTPS 补丁基准不符：' + name);
    const afterProxyProbe2 = proxyProbe2File?.approved || afterSpaDiag;
    const logoutGuardFile = logoutGuard.files[name];
    if (logoutGuardFile && logoutGuardFile.original !== afterProxyProbe2) throw new Error('登出防护补丁基准不符：' + name);
    const afterLogoutGuard = logoutGuardFile?.approved || afterProxyProbe2;
    const pricingVerifyFile = pricingVerify.files[name];
    if (pricingVerifyFile && pricingVerifyFile.original !== afterLogoutGuard) throw new Error('定价页校验补丁基准不符：' + name);
    const afterPricingVerify = pricingVerifyFile?.approved || afterLogoutGuard;
    const bearerFixFile = bearerFix.files[name];
    if (bearerFixFile && bearerFixFile.original !== afterPricingVerify) throw new Error('Bearer 收窄补丁基准不符：' + name);
    const afterBearerFix = bearerFixFile?.approved || afterPricingVerify;
    const deviceCookieFile = deviceCookie.files[name];
    if (deviceCookieFile && deviceCookieFile.original !== afterBearerFix) throw new Error('设备指纹补丁基准不符：' + name);
    const afterDeviceCookie = deviceCookieFile?.approved || afterBearerFix;
    const billingTuneFile = billingTune.files[name];
    if (billingTuneFile && billingTuneFile.original !== afterDeviceCookie) throw new Error('账单填写调优补丁基准不符：' + name);
    const afterBillingTune = billingTuneFile?.approved || afterDeviceCookie;
    const cityFixFile = cityFix.files[name];
    if (cityFixFile && cityFixFile.original !== afterBillingTune) throw new Error('城市必填补丁基准不符：' + name);
    const afterCityFix = cityFixFile?.approved || afterBillingTune;
    const regionSessionMatchFile = regionSessionMatch.files[name];
    if (regionSessionMatchFile && regionSessionMatchFile.original !== afterCityFix) throw new Error('地区一致性补丁基准不符：' + name);
    const afterRegionSessionMatch = regionSessionMatchFile?.approved || afterCityFix;
    const planNameOptionalFile = planNameOptional.files[name];
    if (planNameOptionalFile && planNameOptionalFile.original !== afterRegionSessionMatch) throw new Error('plan_name 可选补丁基准不符：' + name);
    const afterPlanNameOptional = planNameOptionalFile?.approved || afterRegionSessionMatch;
    const regionWarnOnlyFile = regionWarnOnly.files[name];
    if (regionWarnOnlyFile && regionWarnOnlyFile.original !== afterPlanNameOptional) throw new Error('地区告警补丁基准不符：' + name);
    const afterRegionWarnOnly = regionWarnOnlyFile?.approved || afterPlanNameOptional;
    const fingerprintAlignFile = fingerprintAlign.files[name];
    if (fingerprintAlignFile && fingerprintAlignFile.original !== afterRegionWarnOnly) throw new Error('指纹对齐补丁基准不符：' + name);
    const afterFingerprintAlign = fingerprintAlignFile?.approved || afterRegionWarnOnly;
    const realSessionFile = realSession.files[name];
    if (realSessionFile && realSessionFile.original !== afterFingerprintAlign) throw new Error('真实会话补丁基准不符：' + name);
    const afterRealSession = realSessionFile?.approved || afterFingerprintAlign;
    const formWaitFile = formWait.files[name];
    if (formWaitFile && formWaitFile.original !== afterRealSession) throw new Error('表单等待补丁基准不符：' + name);
    const afterFormWait = formWaitFile?.approved || afterRealSession;
    const selectConfirmFile = selectConfirm.files[name];
    if (selectConfirmFile && selectConfirmFile.original !== afterFormWait) throw new Error('下拉确认补丁基准不符：' + name);
    const afterSelectConfirm = selectConfirmFile?.approved || afterFormWait;
    const msgFixFile = msgFix.files[name];
    if (msgFixFile && msgFixFile.original !== afterSelectConfirm) throw new Error('文案修正补丁基准不符：' + name);
    const afterMsgFix = msgFixFile?.approved || afterSelectConfirm;
    const msgFix2File = msgFix2.files[name];
    if (msgFix2File && msgFix2File.original !== afterMsgFix) throw new Error('文案修正二基准不符：' + name);
    const afterMsgFix2 = msgFix2File?.approved || afterMsgFix;
    const waitTuneFile = waitTune.files[name];
    if (waitTuneFile && waitTuneFile.original !== afterMsgFix2) throw new Error('等待调优补丁基准不符：' + name);
    const afterWaitTune = waitTuneFile?.approved || afterMsgFix2;
    const adminTextFile = adminText.files[name];
    if (adminTextFile && adminTextFile.original !== afterWaitTune) throw new Error('前端文案补丁基准不符：' + name);
    const afterAdminText = adminTextFile?.approved || afterWaitTune;
    const pricingWaitProfileFile = pricingWaitProfile.files[name];
    if (pricingWaitProfileFile && pricingWaitProfileFile.original !== afterAdminText) throw new Error('定价页等待补丁基准不符：' + name);
    const afterPricingWaitProfile = pricingWaitProfileFile?.approved || afterAdminText;
    const msgLenGuardFile = msgLenGuard.files[name];
    if (msgLenGuardFile && msgLenGuardFile.original !== afterPricingWaitProfile) throw new Error('日志长度保护补丁基准不符：' + name);
    const afterMsgLenGuard = msgLenGuardFile?.approved || afterPricingWaitProfile;
    const waitAllModesFile = waitAllModes.files[name];
    if (waitAllModesFile && waitAllModesFile.original !== afterMsgLenGuard) throw new Error('全模式等待补丁基准不符：' + name);
    const afterWaitAllModes = waitAllModesFile?.approved || afterMsgLenGuard;
    const unifyWaitFile = unifyWait.files[name];
    if (unifyWaitFile && unifyWaitFile.original !== afterWaitAllModes) throw new Error('统一等待补丁基准不符：' + name);
    const expected = unifyWaitFile?.approved || afterWaitAllModes;
    if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode))
      throw new Error('锁定仓库包含不支持的文件类型');
    const path = resolve(destination, name);
    if (!isDescendant(destination, path)) throw new Error('锁定仓库路径无效');
    const stat = await lstat(path).catch(() => null);
    if (!stat || (mode === '120000' ? !stat.isSymbolicLink() : !stat.isFile() || stat.isSymbolicLink()))
      throw new Error('原版充值文件缺失或类型改变：' + name);
    if (mode !== '120000' && !isDescendant(destination, await realpath(path)))
      throw new Error('原版充值文件不能指向运行目录外');
    if (mode !== '120000' && Boolean(stat.mode & 0o111) !== (mode === '100755'))
      throw new Error('原版充值文件权限改变：' + name);
    const content = mode === '120000' ? Buffer.from(await readlink(path)) : await readFile(path);
    const actual = createHash('sha1').update('blob ' + content.length + '\0').update(content).digest('hex');
    if (actual !== expected) throw new Error('原版充值文件被改写：' + name);
    files++;
  }
  if (!files) throw new Error('锁定充值仓库没有可核验的源码');
  return { revision: CODEXDAICHONG_REVISION, files,
    originalFiles: files - new Set([...routingFiles, ...Object.keys(returns.files), ...cardPlanFiles, ...plusTrialFiles, ...sessionRestoreFiles, ...proCardFiles, ...retryPolicyFiles, ...debugFillFiles, ...regionJpFiles, ...sessionResetFiles, ...proxyProbeFiles, ...poolLockCleanFiles, ...spaDiagFiles, ...proxyProbe2Files, ...logoutGuardFiles, ...pricingVerifyFiles, ...bearerFixFiles, ...deviceCookieFiles, ...billingTuneFiles, ...cityFixFiles, ...regionSessionMatchFiles, ...planNameOptionalFiles, ...regionWarnOnlyFiles, ...fingerprintAlignFiles, ...realSessionFiles, ...formWaitFiles, ...selectConfirmFiles, ...msgFixFiles, ...msgFix2Files, ...waitTuneFiles, ...adminTextFiles, ...pricingWaitProfileFiles, ...msgLenGuardFiles, ...waitAllModesFiles, ...unifyWaitFiles]).size,
    routingFiles: [...routingFiles], returnFiles: Object.keys(returns.files), returnPatchSha256: returns.patchSha256,
    routingPatchSha256: routing.patchSha256, providerRetirementFiles: [...providerRetirementFiles],
    providerRetirementPatchSha256: retirement.patchSha256, cardPlanFiles: [...cardPlanFiles],
    cardPlanPatchSha256: cardPlans.patchSha256, plusTrialFiles: [...plusTrialFiles], retryFiles: [...retryFiles],
    plusTrialPatchSha256: plusTrial.patchSha256, retryPatchSha256: retry.patchSha256,
    proCardFiles: [...proCardFiles], proCardPatchSha256: proCard.patchSha256,
    retryPolicyFiles: [...retryPolicyFiles], retryPolicyPatchSha256: retryPolicy.patchSha256,
    sessionRestoreFiles: [...sessionRestoreFiles], sessionRestorePatchSha256: sessionRestore.patchSha256,
    debugFillFiles: [...debugFillFiles], debugFillPatchSha256: debugFill.patchSha256,
    regionJpFiles: [...regionJpFiles], regionJpPatchSha256: regionJp.patchSha256,
    sessionResetFiles: [...sessionResetFiles], sessionResetPatchSha256: sessionReset.patchSha256,
    proxyProbeFiles: [...proxyProbeFiles], proxyProbePatchSha256: proxyProbe.patchSha256,
    poolLockCleanFiles: [...poolLockCleanFiles], poolLockCleanPatchSha256: poolLockClean.patchSha256,
    spaDiagFiles: [...spaDiagFiles], spaDiagPatchSha256: spaDiag.patchSha256,
    proxyProbe2Files: [...proxyProbe2Files], proxyProbe2PatchSha256: proxyProbe2.patchSha256,
    logoutGuardFiles: [...logoutGuardFiles], logoutGuardPatchSha256: logoutGuard.patchSha256,
    pricingVerifyFiles: [...pricingVerifyFiles], pricingVerifyPatchSha256: pricingVerify.patchSha256,
    bearerFixFiles: [...bearerFixFiles], bearerFixPatchSha256: bearerFix.patchSha256,
    deviceCookieFiles: [...deviceCookieFiles], deviceCookiePatchSha256: deviceCookie.patchSha256,
    billingTuneFiles: [...billingTuneFiles], billingTunePatchSha256: billingTune.patchSha256,
    cityFixFiles: [...cityFixFiles], cityFixPatchSha256: cityFix.patchSha256,
    regionSessionMatchFiles: [...regionSessionMatchFiles], regionSessionMatchPatchSha256: regionSessionMatch.patchSha256,
    planNameOptionalFiles: [...planNameOptionalFiles], planNameOptionalPatchSha256: planNameOptional.patchSha256,
    regionWarnOnlyFiles: [...regionWarnOnlyFiles], regionWarnOnlyPatchSha256: regionWarnOnly.patchSha256,
    fingerprintAlignFiles: [...fingerprintAlignFiles], fingerprintAlignPatchSha256: fingerprintAlign.patchSha256,
    realSessionFiles: [...realSessionFiles], realSessionPatchSha256: realSession.patchSha256,
    formWaitFiles: [...formWaitFiles], formWaitPatchSha256: formWait.patchSha256,
    selectConfirmFiles: [...selectConfirmFiles], selectConfirmPatchSha256: selectConfirm.patchSha256,
    msgFixFiles: [...msgFixFiles], msgFixPatchSha256: msgFix.patchSha256,
    msgFix2Files: [...msgFix2Files], msgFix2PatchSha256: msgFix2.patchSha256,
    waitTuneFiles: [...waitTuneFiles], waitTunePatchSha256: waitTune.patchSha256,
    adminTextFiles: [...adminTextFiles], adminTextPatchSha256: adminText.patchSha256,
    pricingWaitProfileFiles: [...pricingWaitProfileFiles], pricingWaitProfilePatchSha256: pricingWaitProfile.patchSha256,
    msgLenGuardFiles: [...msgLenGuardFiles], msgLenGuardPatchSha256: msgLenGuard.patchSha256,
    waitAllModesFiles: [...waitAllModesFiles], waitAllModesPatchSha256: waitAllModes.patchSha256,
    unifyWaitFiles: [...unifyWaitFiles], unifyWaitPatchSha256: unifyWait.patchSha256 };
}

export async function prepareCodexdaichong(outputDir = resolve(runtimeRoot, 'codexdaichong')) {
  const destination = resolve(outputDir);
  if (!isDescendant(runtimeRoot, destination)) {
    throw new Error('运行副本须放在本项目的 .runtime 下');
  }
  const { stdout } = await exec('git', [
    '-C',
    sourceRoot,
    'rev-parse',
    CODEXDAICHONG_REVISION + '^{commit}'
  ]);
  if (stdout.trim() !== CODEXDAICHONG_REVISION) {
    throw new Error('未找到锁定的线上代充源码');
  }

  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const realRuntimeRoot = await realpath(runtimeRoot);
  const realProjectRoot = await realpath(projectRoot);
  if (realRuntimeRoot !== resolve(realProjectRoot, '.runtime')) {
    throw new Error('运行副本目录不能是符号链接');
  }
  const parent = await realpath(dirname(destination));
  if (parent !== realRuntimeRoot && !isDescendant(realRuntimeRoot, parent)) {
    throw new Error('运行副本的父目录不在本项目 .runtime 下');
  }
  await mkdir(destination, { mode: 0o700 });
  await extractPinnedSource(destination);
  await applyApprovedRechargeRouting(destination);
  await verifyCodexdaichongSource(destination);
  await writeFile(
    resolve(destination, '.id-business-integrated-runtime'),
    CODEXDAICHONG_REVISION + '\n',
    { flag: 'wx' }
  );
  await writeFile(resolve(destination, '.id-business-production-guard'), PRODUCTION_GUARD_REVISION + '\n', { flag: 'wx' });
  return destination;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const directory = await prepareCodexdaichong(process.argv[2]);
    console.log('线上代充隔离运行副本已准备：' + directory);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
