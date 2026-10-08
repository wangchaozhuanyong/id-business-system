import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const NATIVE_FINANCE_FORMAT = 'id-business-native-finance-v1';
export const FINANCE_ARTIFACT_ROOTS = Object.freeze([
  'package.json',
  'package-lock.json',
  'scripts/native-finance-audit.mjs',
  'scripts/native-finance-artifact.mjs',
  'scripts/lib/v2-data-integrity-audit.mjs',
  'scripts/lib/v2-historical-cash-adjustment-audit.mjs',
  'apps/api/prisma-mysql/schema.prisma',
  'node_modules/@prisma/client',
  'node_modules/.prisma/client'
]);
const sourcePaths = FINANCE_ARTIFACT_ROOTS.filter((path) => !path.startsWith('node_modules/'));
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireValue = (value) => {
  if (!value) throw new Error('原生财务制品身份检查未通过');
};
const canonical = (value) => JSON.stringify(value);

function safeRoot(root) {
  requireValue(isAbsolute(root) && realpathSync(root) === resolve(root));
  return resolve(root);
}

function filesUnder(root, path) {
  requireValue(typeof path === 'string' && !isAbsolute(path) && !path.split('/').includes('..'));
  const full = resolve(root, path);
  const rel = relative(root, full);
  requireValue(rel && !rel.startsWith(`..${sep}`) && rel !== '..' && realpathSync(full) === full);
  const stat = lstatSync(full);
  requireValue(!stat.isSymbolicLink());
  if (stat.isDirectory()) {
    return readdirSync(full)
      .sort()
      .flatMap((name) => filesUnder(root, `${path}/${name}`));
  }
  requireValue(stat.isFile() && stat.size <= 128 * 1024 * 1024);
  return [{ path, bytes: stat.size, sha256: sha256(readFileSync(full)) }];
}

export function financeArtifactFiles(root) {
  root = safeRoot(root);
  const files = FINANCE_ARTIFACT_ROOTS.flatMap((path) => filesUnder(root, path));
  requireValue(files.length > sourcePaths.length && files.length <= 10000);
  requireValue(new Set(files.map((file) => file.path)).size === files.length);
  return files;
}

function gitIdentity(root, run = spawnSync) {
  const read = (args, regex) => {
    const result = run('git', ['-C', root, ...args], { encoding: 'utf8', shell: false });
    requireValue(result.status === 0 && regex.test(result.stdout.trim()));
    return result.stdout.trim();
  };
  requireValue(read(['rev-parse', '--show-toplevel'], /^\/.+$/) === root);
  return {
    commit: read(['rev-parse', 'HEAD'], /^[0-9a-f]{40}$/),
    tree: read(['rev-parse', 'HEAD^{tree}'], /^[0-9a-f]{40}$/),
    candidateSourceSha256: sha256(canonical(sourcePaths.flatMap((path) => filesUnder(root, path))))
  };
}

export async function sealFinanceArtifact({ root, source, output }, dependencies = {}) {
  root = safeRoot(root);
  source = safeRoot(source);
  requireValue(
    isAbsolute(output) && !FINANCE_ARTIFACT_ROOTS.some((path) => output === resolve(root, path))
  );
  requireValue(realpathSync(dirname(output)) === resolve(dirname(output)));
  const files = financeArtifactFiles(root);
  for (const path of sourcePaths) {
    requireValue(
      sha256(readFileSync(resolve(source, path))) ===
        files.find((file) => file.path === path).sha256
    );
  }
  const library = await import(
    pathToFileURL(resolve(root, 'scripts/lib/v2-data-integrity-audit.mjs'))
  );
  requireValue(library.V2_DATA_INTEGRITY_CHECKS.length === 49);
  const manifest = {
    format: NATIVE_FINANCE_FORMAT,
    source: gitIdentity(source, dependencies.run),
    nodeMajor: 24,
    rulesSha256: sha256(canonical(library.V2_DATA_INTEGRITY_CHECKS)),
    checkCount: 49,
    files
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 });
  return { ok: true, manifestSha256: sha256(bytes), fileCount: files.length, checkCount: 49 };
}

export function verifyFinanceArtifact({ root, manifestPath, manifestSha256 }) {
  root = safeRoot(root);
  requireValue(isAbsolute(manifestPath) && /^[0-9a-f]{64}$/.test(manifestSha256));
  requireValue(lstatSync(manifestPath).isFile() && !lstatSync(manifestPath).isSymbolicLink());
  const bytes = readFileSync(manifestPath);
  requireValue(bytes.length <= 4 * 1024 * 1024 && sha256(bytes) === manifestSha256);
  const manifest = JSON.parse(bytes);
  requireValue(
    manifest.format === NATIVE_FINANCE_FORMAT &&
      manifest.nodeMajor === 24 &&
      manifest.checkCount === 49 &&
      /^[0-9a-f]{40}$/.test(manifest.source?.commit) &&
      /^[0-9a-f]{40}$/.test(manifest.source?.tree) &&
      /^[0-9a-f]{64}$/.test(manifest.source?.candidateSourceSha256) &&
      /^[0-9a-f]{64}$/.test(manifest.rulesSha256)
  );
  requireValue(canonical(financeArtifactFiles(root)) === canonical(manifest.files));
  requireValue(
    sha256(canonical(manifest.files.filter((file) => sourcePaths.includes(file.path)))) ===
      manifest.source.candidateSourceSha256
  );
  return manifest;
}

export function verifyFinanceRunner(manifest, auditUrl) {
  for (const [path, url] of [
    ['scripts/native-finance-audit.mjs', auditUrl],
    ['scripts/native-finance-artifact.mjs', import.meta.url]
  ]) {
    const runner = fileURLToPath(url);
    const sealed = manifest.files.find((file) => file.path === path);
    requireValue(
      sealed && realpathSync(runner) === runner && sha256(readFileSync(runner)) === sealed.sha256
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    requireValue(['seal', 'check'].includes(command));
    const values = {};
    for (const arg of args) {
      const match = /^--(root|source|output|manifest|sha256)=(.+)$/.exec(arg);
      requireValue(match && !Object.hasOwn(values, match[1]));
      values[match[1]] = match[2];
    }
    const result =
      command === 'seal'
        ? await sealFinanceArtifact({
            root: values.root,
            source: values.source,
            output: values.output
          })
        : verifyFinanceArtifact({
            root: values.root,
            manifestPath: values.manifest,
            manifestSha256: values.sha256
          });
    console.log(
      JSON.stringify(
        command === 'seal'
          ? result
          : { ok: true, checkCount: result.checkCount, fileCount: result.files.length }
      )
    );
  } catch {
    console.error('原生财务制品检查失败，原始路径、配置和错误已隐藏');
    process.exitCode = 1;
  }
}
