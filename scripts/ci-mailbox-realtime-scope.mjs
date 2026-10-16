import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const mailboxRealtimeBase = '44c9134833242815d01ba666fe0f942f924347fb';
export const mailboxRealtimeParts = ['guards', 'api', 'admin', 'release-controls'];
export const mailboxControlBase = 'b89ac82c3ea11c303742261d425d78a7c03be506';
export const mailboxControlTree = '959aa28018ceb606e979f9ba1b50d667d3ce4c3a';
export const mailboxControlPaths = [
  'scripts/ci-mailbox-realtime-scope.mjs',
  'scripts/production-release/mailbox-realtime-baseline.py',
  'scripts/production-release/mailbox-realtime-contract.json',
  'scripts/production-release/mailbox-realtime-release.test.py'
];

export function isMailboxRealtimeControlsOnly(paths, context) {
  if (context?.base !== mailboxControlBase || context?.baseTree !== mailboxControlTree)
    return false;
  if (
    paths.length !== mailboxControlPaths.length ||
    new Set(paths).size !== paths.length ||
    paths.some((name) => !mailboxControlPaths.includes(name))
  )
    return false;
  // Reuse the original full source fingerprint; the repair cannot change shipped application bytes.
  try {
    const c = JSON.parse(
      readFileSync('scripts/production-release/mailbox-realtime-contract.json', 'utf8')
    );
    return isMailboxRealtimeOnly(c.expectedGitChanges, {
      base: c.sourceBaseline,
      baseTree: c.sourceBaselineTree
    });
  } catch {
    return false;
  }
}

export function isMailboxRealtimeOnly(paths, context) {
  try {
    const c = JSON.parse(
      readFileSync('scripts/production-release/mailbox-realtime-contract.json', 'utf8')
    );
    if (context && (context.base !== c.sourceBaseline || context.baseTree !== c.sourceBaselineTree))
      return false;
    if (
      c.frozen !== true ||
      c.scope !== 'MAILBOX_REALTIME_20261016' ||
      c.sourceBaseline !== mailboxRealtimeBase ||
      c.migration !== null
    )
      return false;
    if (
      paths.length !== c.expectedGitChanges.length ||
      new Set(paths).size !== paths.length ||
      paths.some((n) => !c.expectedGitChanges.includes(n))
    )
      return false;
    return Object.entries(c.reviewedFileHashes).every(
      ([name, expected]) =>
        createHash('sha256').update(readFileSync(name)).digest('hex') === expected
    );
  } catch {
    return false;
  }
}
