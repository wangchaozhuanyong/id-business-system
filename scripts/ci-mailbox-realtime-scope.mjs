import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const mailboxRealtimeBase = '6fc99d23c2918280a94c3f5b8be48f638190e02f';
export const mailboxRealtimeParts = ['guards', 'api', 'admin', 'release-controls'];
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
