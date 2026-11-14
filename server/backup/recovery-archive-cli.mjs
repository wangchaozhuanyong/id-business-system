import { sealRecoveryState, openRecoveryState } from './recovery-archive.mjs';

// Private pipe only: neither a recovery key nor plaintext belongs in argv/logs.
try {
  if (process.stdin.isTTY || !['seal', 'verify'].includes(process.argv[2]) || process.argv.length !== 3)
    throw new Error();
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 160 * 1024 * 1024) throw new Error();
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  let input;
  try { input = JSON.parse(raw); } finally { raw.fill(0); for (const chunk of chunks) chunk.fill(0); }
  if (process.argv[2] === 'seal') {
    const { archive, receipt } = sealRecoveryState(input.state, input.recipient);
    process.stdout.write(archive);
    process.stderr.write(JSON.stringify(receipt) + '\n');
  } else {
    const { receipt } = openRecoveryState(Buffer.from(input.archive, 'base64'), input.key);
    process.stdout.write(JSON.stringify({ ...receipt, verified: true }) + '\n');
  }
} catch (error) {
  const safeCodes = new Set(['RECOVERY_STATE_INVALID', 'RECOVERY_DIRECTORY_INVALID',
    'RECOVERY_ENTRY_INVALID', 'RECOVERY_DIRECTORY_MISSING', 'RECOVERY_REQUIRED_STATE_MISSING',
    'RECOVERY_RUNTIME_STATE_FORBIDDEN', 'RECOVERY_PUBLIC_KEY_REQUIRED', 'RECOVERY_STATE_TOO_LARGE',
    'RECOVERY_STATE_VERIFICATION_FAILED']);
  process.stderr.write((safeCodes.has(error?.message) ? error.message : 'RECOVERY_ARCHIVE_OPERATION_FAILED') + '\n');
  process.exitCode = 1;
}
