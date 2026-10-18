import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const contractPath = 'scripts/production-release/feature-retirement-contract.json';
const verifierPath = 'scripts/production-release/feature-retirement-build.py';
const workflowPath = '.github/workflows/feature-retirement-validation.yml';
const sourceHash = '4c8dff6c4b1875ba3ef2bdef618bac6e6e0a8eb2c61a4805a2e875e20aac9647';
const verifierHash = '82293f9bbb3c4341f75ac9eb2075ffac52c4855862a55500b82e700ef3f0c489';
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
      c.reviewBase !== c.adminSourceBaseline ||
      c.adminSourceBaseline !== 'b8c37f1262a42398a43a1acd3ff4504d17c1bed8' ||
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

// This continuation changes only publication controls after a pre-switch failure.
// The accepted main tree already passed all application and MySQL checks.
export const retirementPermissionsBase = '79484464ec1c4f46a88072cf4b60926157bbaee6';
export const retirementPermissionsPaths = Object.freeze([
  contractPath,
  'scripts/production-release/feature-retirement-release.py',
  'scripts/production-release/feature-retirement-release.test.py',
  'scripts/ci-feature-retirement-scope.mjs'
]);
export function isFeatureRetirementPermissionsRepair(paths, context = {}) {
  try {
    if (!samePaths(paths, retirementPermissionsPaths)) return false;
    const read =
      context.readFile ?? ((name) => readFileSync(new URL('../' + name, import.meta.url)));
    const before =
      context.baselineContract ??
      JSON.parse(
        execFileSync('git', ['show', retirementPermissionsBase + ':' + contractPath], {
          cwd: root,
          encoding: 'utf8'
        })
      );
    const after = JSON.parse(read(contractPath).toString());
    const allowedControls = retirementPermissionsPaths.filter((name) => name !== contractPath);
    if (
      digest(read('scripts/production-release/feature-retirement-release.py')) !==
        '35e0c05885c23b0ebb113c2b940cbfbe767d84d208aaa6b472a76fef9f5a9c4e' ||
      digest(read('scripts/production-release/feature-retirement-release.test.py')) !==
        'f6612dfca9c0c8c968eb18316548df50c4e0982c1871a6616a4f1b10a21277a1'
    )
      return false;
    for (const [name, expected] of Object.entries(after.controlSources ?? {})) {
      if (expected !== digest(read(name))) return false;
    }
    const restored = structuredClone(after);
    for (const name of allowedControls) restored.controlSources[name] = before.controlSources[name];
    if (JSON.stringify(restored) !== JSON.stringify(before)) return false;
    const changed =
      context.changedFromPermissionsBase ??
      (() =>
        execFileSync(
          'git',
          ['diff', '--name-only', '--no-renames', retirementPermissionsBase, 'HEAD'],
          { cwd: root, encoding: 'utf8' }
        )
          .trim()
          .split('\n')
          .filter(Boolean));
    if (!samePaths(paths, changed())) return false;
    return (context.verifySource ?? verifySource)() === true;
  } catch {
    return false;
  }
}
