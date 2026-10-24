import { lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const awsAccountMigrationControlManifest =
  'deploy/aws/account-migration-controls-20261024.json';
export function isAwsAccountMigrationControlsOnly(paths, context) {
  if (!paths.includes(awsAccountMigrationControlManifest)) return false;
  try {
    const rootFile = (path) => new URL('../' + path, import.meta.url);
    const record = JSON.parse(readFileSync(rootFile(awsAccountMigrationControlManifest), 'utf8'));
    if (record.version !== 1 || record.sourceCommit !== 'a046d8413e3cb6c3edd6429dbdb922593dc32064'
        || record.sourceAccount !== '079740175286' || record.targetAccount !== '098208446664'
        || (context?.base && context.base !== record.sourceCommit)
        || !record.files || Array.isArray(record.files)) return false;
    const entries = Object.entries(record.files);
    if (!entries.length || entries.length > 128 || paths.length !== entries.length + 1
        || new Set(paths).size !== paths.length) return false;
    const allowed = /^(?:\.github\/workflows\/[\w.-]+\.yml|scripts\/production-release\/[\w.-]+\.(?:py|mjs|sh)|scripts\/ci-(?:recharge-scope|aws-account-migration-scope)(?:\.test)?\.mjs|deploy\/aws\/(?:disk-retention-policy-20261014|release-artifact-storage-proof-20261024)\.json)$/;
    return entries.every(([path, expected]) => {
      if (!allowed.test(path) || !paths.includes(path) || !/^[a-f0-9]{64}$/.test(expected))
        return false;
      const stat = lstatSync(rootFile(path));
      return stat.isFile() && !stat.isSymbolicLink()
        && createHash('sha256').update(readFileSync(rootFile(path))).digest('hex') === expected;
    });
  } catch { return false; }
}
