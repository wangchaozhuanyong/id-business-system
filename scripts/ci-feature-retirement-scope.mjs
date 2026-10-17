import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const contractPath = 'scripts/production-release/feature-retirement-contract.json';
const verifierPath = 'scripts/production-release/feature-retirement-build.py';
const workflowPath = '.github/workflows/feature-retirement-validation.yml';
const sourceHash = '1c91563df6fbdabb7c7724292fe9c637681c237560d9fbddee043eb87af30cf5';
const verifierHash = '02ae8491ff41d9de2803115c7fe14b487630b2faf6ad2eea6d203e00931ac6bf';
const workflowHash = '7c5fb7c5f845ef94a9ddd117f5002b8d33bc0f3155c254c1acf6a340e5308c64';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const samePaths = (left, right) =>
  Array.isArray(right) &&
  new Set(left).size === left.length &&
  new Set(right).size === right.length &&
  left.length === right.length &&
  left.every((name) => right.includes(name));

function verifySource() {
  const code =
    "import importlib.util,json;from pathlib import Path;p=Path('scripts/production-release/feature-retirement-build.py');s=importlib.util.spec_from_file_location('retirement_ci_source',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.verify_sources(json.loads(m.CONTRACT.read_text()))";
  const result = spawnSync('python3', ['-B', '-c', code], {
    cwd: root,
    encoding: 'utf8',
    timeout: 90000,
    maxBuffer: 1024 * 1024
  });
  return result.status === 0 && !result.error;
}

// Only the exact retirement application uses its dedicated bounded build and
// live-image verification. Normal full quality checks remain required. The
// historical ONLINE image recipe continues to reject later application inputs.
export function isFeatureRetirementOnly(paths, context = {}) {
  try {
    if (!Array.isArray(paths) || !paths.includes(contractPath)) return false;
    const read =
      context.readFile ?? ((name) => readFileSync(new URL('../' + name, import.meta.url)));
    const c = JSON.parse(read(contractPath).toString());
    const sources = JSON.stringify(Object.fromEntries(Object.entries(c.sources).sort()));
    if (
      c.scope !== 'AUTO_REGISTRATION_RETIREMENT_20261018' ||
      c.apiSourceBaseline !== 'c28551daa8a510a6922ae842d746ce8093898115' ||
      c.apiMainBase !== c.apiSourceBaseline ||
      typeof c.reviewBase !== 'string' ||
      !/^[a-f0-9]{40}$/.test(c.reviewBase) ||
      c.adminSourceBaseline !== '6da10d2e4bd9de6df145899648e234000f84b72b' ||
      c.backupCreated !== false ||
      c.cleanupDataInRelease !== false ||
      c.migrationPerformed !== false ||
      c.businessActions !== 0 ||
      digest(sources) !== sourceHash ||
      digest(read(verifierPath)) !== verifierHash ||
      digest(read(workflowPath)) !== workflowHash ||
      !Array.isArray(c.allowedPaths) ||
      new Set(c.allowedPaths).size !== c.allowedPaths.length ||
      c.allowedPaths.some((name) => name.startsWith('apps/api/src/id-business-v2/online-recharge/'))
    )
      return false;
    // CI's normal Git diff represents a rename by its destination only. The
    // source verifier below still checks the complete --no-renames inventory.
    if (!samePaths(paths, c.allowedPaths)) {
      const changed =
        context.changedPaths ??
        ((base) =>
          execFileSync('git', ['diff', '--name-only', base, 'HEAD'], {
            cwd: root,
            encoding: 'utf8'
          })
            .trim()
            .split('\n')
            .filter(Boolean));
      if (!samePaths(paths, changed(c.reviewBase))) return false;
    }
    return (context.verifySource ?? verifySource)() === true;
  } catch {
    return false;
  }
}
