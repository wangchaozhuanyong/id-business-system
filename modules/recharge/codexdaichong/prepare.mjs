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
const plusTrialFiles = ['pricing-checkout.js'];

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

async function approvedPlusTrial(routing) {
  const manifest = JSON.parse(await readFile(new URL('./plus-trial/manifest.json', import.meta.url), 'utf8'));
  const patch = await readFile(plusTrialPatch);
  const names = [...patch.toString().matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match => match[1]).sort();
  if (manifest.revision !== CODEXDAICHONG_REVISION ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(plusTrialFiles) ||
      JSON.stringify(names) !== JSON.stringify(plusTrialFiles) ||
      plusTrialFiles.some(name => manifest.files[name].original !== routing.files[name]?.approved) ||
      createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256)
    throw new Error('0 元试用补丁与审查清单不符');
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
    const expected = plusTrialFile?.approved || afterCardPlans;
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
    originalFiles: files - new Set([...routingFiles, ...Object.keys(returns.files), ...cardPlanFiles, ...plusTrialFiles]).size,
    routingFiles: [...routingFiles], returnFiles: Object.keys(returns.files), returnPatchSha256: returns.patchSha256,
    routingPatchSha256: routing.patchSha256, providerRetirementFiles: [...providerRetirementFiles],
    providerRetirementPatchSha256: retirement.patchSha256, cardPlanFiles: [...cardPlanFiles],
    cardPlanPatchSha256: cardPlans.patchSha256, plusTrialFiles: [...plusTrialFiles],
    plusTrialPatchSha256: plusTrial.patchSha256 };
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
