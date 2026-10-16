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
export const mailboxHealthCaptureBase = '3714bd6a27859307f27ec3379b5e176e4e395636';
export const mailboxHealthCaptureTree = 'c297dfd5fd0353119a3a0c7ded14434b972fb829';
export const mailboxHealthCapturePaths = [
  '.github/workflows/mailbox-realtime-validation.yml',
  'scripts/ci-mailbox-realtime-scope.mjs',
  'scripts/ci-mailbox-realtime-scope.test.mjs',
  'scripts/production-release/mailbox-realtime-contract.json',
  'scripts/production-release/mailbox-realtime-inspect.py',
  'scripts/production-release/mailbox-realtime-release.test.py'
];

export function isMailboxRealtimeControlsOnly(paths, context) {
  const healthCapture =
    context?.base === mailboxHealthCaptureBase && context?.baseTree === mailboxHealthCaptureTree;
  if (
    !healthCapture &&
    (context?.base !== mailboxControlBase || context?.baseTree !== mailboxControlTree)
  )
    return false;
  const allowed = healthCapture ? mailboxHealthCapturePaths : mailboxControlPaths;
  if (
    paths.length !== allowed.length ||
    new Set(paths).size !== paths.length ||
    paths.some((name) => !allowed.includes(name))
  )
    return false;
  // Reuse the original full source fingerprint; the repair cannot change shipped application bytes.
  try {
    const c = JSON.parse(
      readFileSync('scripts/production-release/mailbox-realtime-contract.json', 'utf8')
    );
    if (
      healthCapture &&
      (c.healthInspection?.readOnly !== true ||
        c.healthInspection.publishedCommit !== '59b36f3aadef28a59f47a55ed1e66686fcc2c42c' ||
        Object.keys(c.healthInspection.hashes).length !== allowed.length - 1 ||
        allowed
          .filter((n) => !n.endsWith('mailbox-realtime-contract.json'))
          .some(
            (n) =>
              createHash('sha256').update(readFileSync(n)).digest('hex') !==
              c.healthInspection.hashes[n]
          ))
    )
      return false;
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
