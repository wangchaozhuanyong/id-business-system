import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_BACKOFF_MS = 5_000;
const DEFAULT_FETCH_TIMEOUT_MS = '15000';

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

const HIGH_SEVERITY_FINDING_PATTERNS = [
  /\b[1-9]\d* high severity vulnerabilit(?:y|ies)\b/i,
  /\b[1-9]\d* critical severity vulnerabilit(?:y|ies)\b/i
];

export function hasHighSeverityNpmAuditFinding(output) {
  return HIGH_SEVERITY_FINDING_PATTERNS.some((pattern) => pattern.test(output));
}

export function isTransientNpmAuditFailure(output) {
  return (
    !hasHighSeverityNpmAuditFinding(output) &&
    TRANSIENT_FAILURE_PATTERNS.some((pattern) => pattern.test(output))
  );
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
  allowInfrastructureFailure = false,
  warn = (message) => console.warn(message)
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runAttempt(attempt);

    if (result.code === 0) {
      return 0;
    }

    const isInfrastructureFailure =
      !result.spawnError && !result.signal && isTransientNpmAuditFailure(result.output);

    if (!isInfrastructureFailure) {
      return result.code || 1;
    }

    if (attempt === maxAttempts) {
      if (allowInfrastructureFailure) {
        warn(
          `npm audit infrastructure remained unavailable after ${maxAttempts} attempts; continuing under the explicit infrastructure warning policy`
        );
        return 0;
      }
      return result.code || 1;
    }

    const nextAttempt = attempt + 1;
    warn(`npm audit infrastructure failure; retrying attempt ${nextAttempt} of ${maxAttempts}`);
    await waitForRetry(attempt * backoffMs);
  }

  return 1;
}

async function main() {
  const infrastructurePolicy = process.env.NPM_AUDIT_INFRASTRUCTURE_POLICY ?? 'fail';
  if (!['fail', 'warn'].includes(infrastructurePolicy)) {
    throw new Error(
      `Unsupported NPM_AUDIT_INFRASTRUCTURE_POLICY: ${infrastructurePolicy}; expected fail or warn`
    );
  }

  process.exitCode = await runAuditWithRetry({
    allowInfrastructureFailure: infrastructurePolicy === 'warn'
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
