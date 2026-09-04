import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_BACKOFF_MS = 15_000;
const DEFAULT_FETCH_TIMEOUT_MS = '60000';

const TRANSIENT_FAILURE_PATTERNS = [
  /network timeout/i,
  /audit endpoint returned an error/i,
  /503 Service Unavailable/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bEAI_AGAIN\b/i,
  /\bENOTFOUND\b/i,
  /socket hang up/i
];

export function isTransientNpmAuditFailure(output) {
  return TRANSIENT_FAILURE_PATTERNS.some((pattern) => pattern.test(output));
}

function runNpmAudit() {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(command, ['audit', '--omit=dev', '--audit-level=high'], {
    env: {
      ...process.env,
      NPM_CONFIG_FETCH_TIMEOUT: process.env.NPM_CONFIG_FETCH_TIMEOUT ?? DEFAULT_FETCH_TIMEOUT_MS,
      NPM_CONFIG_FETCH_RETRIES: process.env.NPM_CONFIG_FETCH_RETRIES ?? '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return new Promise((resolve) => {
    let output = '';
    let spawnError;

    child.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code, signal) => {
      resolve({ code: code ?? 1, output, signal, spawnError });
    });
  });
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function runAuditWithRetry({
  runAttempt = runNpmAudit,
  waitForRetry = wait,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoffMs = DEFAULT_BACKOFF_MS,
  warn = (message) => console.warn(message)
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runAttempt(attempt);

    if (result.code === 0) {
      return 0;
    }

    if (
      result.spawnError ||
      result.signal ||
      !isTransientNpmAuditFailure(result.output) ||
      attempt === maxAttempts
    ) {
      return result.code || 1;
    }

    const nextAttempt = attempt + 1;
    warn(`npm audit infrastructure failure; retrying attempt ${nextAttempt} of ${maxAttempts}`);
    await waitForRetry(attempt * backoffMs);
  }

  return 1;
}

async function main() {
  process.exitCode = await runAuditWithRetry();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
