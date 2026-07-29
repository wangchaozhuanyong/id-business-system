#!/usr/bin/env node
import { existsSync, statSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const forbiddenPathPrefixes = [
  'backups/',
  'uploads/',
  'tmp/',
  'node_modules/',
  'apps/admin/dist/',
  'apps/api/dist/',
  'packages/shared/dist/'
];
const forbiddenExactPaths = new Set(['.env', '.env.local', '.env.production']);
const forbiddenPathPatterns = [/^\.env\..*\.local$/];

const mustBeIgnored = [
  '.env',
  '.env.local',
  '.env.production',
  'backups/postgres/example.dump',
  'uploads/example.bin',
  'tmp/example.tmp',
  'node_modules/example',
  'apps/admin/dist/index.html',
  'apps/api/dist/main.js',
  'packages/shared/dist/index.js'
];

const secretPatterns = [
  { name: 'OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Bot API token', pattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g },
  {
    name: 'Private key',
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g
  }
];

const textFileExtensions = new Set([
  '',
  '.cjs',
  '.css',
  '.env',
  '.example',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.prisma',
  '.sh',
  '.sql',
  '.ts',
  '.tsx',
  '.vue',
  '.yml',
  '.yaml'
]);

function parseArgs(argv) {
  return {
    verbose: argv.includes('--verbose'),
    help: argv.includes('--help') || argv.includes('-h')
  };
}

function usage() {
  console.log(`Usage:
  npm run git:readiness
  npm run git:readiness:verbose
  node scripts/git-readiness.mjs --verbose

Options:
  --verbose  Print candidate file summaries and samples for review
`);
}

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? 'pipe'
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function parseNullSeparated(output) {
  return output.split('\0').filter(Boolean);
}

function getCandidateFiles() {
  const tracked = parseNullSeparated(runGit(['ls-files', '-z']).stdout);
  const untracked = parseNullSeparated(
    runGit(['ls-files', '--others', '--exclude-standard', '-z']).stdout
  );
  return [...new Set([...tracked, ...untracked])].filter((file) => existsSync(file));
}

function isForbiddenPath(file) {
  return (
    forbiddenExactPaths.has(file) ||
    forbiddenPathPatterns.some((pattern) => pattern.test(file)) ||
    forbiddenPathPrefixes.some((prefix) => file === prefix || file.startsWith(prefix))
  );
}

function isTextCandidate(file) {
  const lastDot = file.lastIndexOf('.');
  const extension = lastDot === -1 ? '' : file.slice(lastDot);
  return textFileExtensions.has(extension);
}

function scanSecrets(file) {
  if (!isTextCandidate(file)) {
    return [];
  }

  const stat = statSync(file);
  if (stat.size > 2_000_000) {
    return [];
  }

  const content = readFileSync(file, 'utf8');
  const findings = [];

  for (const { name, pattern } of secretPatterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(content);
    if (match) {
      const prefix = content.slice(0, match.index);
      const line = prefix.split('\n').length;
      findings.push(`${file}:${line} ${name}`);
    }
  }

  return findings;
}

function checkRemote() {
  const result = runGit(['remote', 'get-url', 'origin']);
  if (result.status !== 0) {
    return 'origin remote is missing';
  }

  const remote = result.stdout.trim();
  if (!remote) {
    return 'origin remote is empty';
  }

  return null;
}

function checkIgnoredPaths() {
  const failures = [];

  for (const path of mustBeIgnored) {
    const result = runGit(['check-ignore', '-q', path]);
    if (result.status !== 0) {
      failures.push(`${path} is not ignored`);
    }
  }

  return failures;
}

function topLevelOf(file) {
  return file.includes('/') ? file.slice(0, file.indexOf('/')) : '(root)';
}

function extensionOf(file) {
  const base = file.split('/').pop() ?? file;
  const dotIndex = base.lastIndexOf('.');
  if (dotIndex <= 0) return '(none)';
  return base.slice(dotIndex);
}

function countBy(items, mapper) {
  const counts = new Map();
  for (const item of items) {
    const key = mapper(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
  );
}

function printCounts(title, counts, limit = 12) {
  console.log(title);
  for (const [key, count] of counts.slice(0, limit)) {
    console.log(`  - ${key}: ${count}`);
  }
  if (counts.length > limit) {
    console.log(`  - ... ${counts.length - limit} more`);
  }
}

function printVerboseSummary(candidateFiles) {
  console.log();
  console.log('Candidate file summary');
  console.log('----------------------');
  printCounts('By top-level path:', countBy(candidateFiles, topLevelOf));
  printCounts('By extension:', countBy(candidateFiles, extensionOf));
  console.log('First 40 candidate files:');
  for (const file of candidateFiles.slice(0, 40)) {
    console.log(`  - ${file}`);
  }
  if (candidateFiles.length > 40) {
    console.log(`  - ... ${candidateFiles.length - 40} more`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const errors = [];
  const warnings = [];
  const remoteError = checkRemote();

  if (remoteError) {
    errors.push(remoteError);
  }

  errors.push(...checkIgnoredPaths());

  const candidateFiles = getCandidateFiles();
  const forbiddenCandidates = candidateFiles.filter(isForbiddenPath);

  if (forbiddenCandidates.length) {
    errors.push(
      `Forbidden files are visible to Git: ${forbiddenCandidates.slice(0, 20).join(', ')}${
        forbiddenCandidates.length > 20 ? ' ...' : ''
      }`
    );
  }

  for (const file of candidateFiles) {
    errors.push(...scanSecrets(file));

    const size = statSync(file).size;
    if (size > 5_000_000) {
      warnings.push(`${file} is larger than 5MB`);
    }
  }

  if (warnings.length) {
    console.warn('Git readiness warnings:');
    for (const warning of warnings) {
      console.warn(`- ${warning}`);
    }
  }

  if (errors.length) {
    console.error('Git readiness check failed:');
    for (const error of [...new Set(errors)]) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  const status = runGit(['status', '--short']).stdout.trim();
  console.log('Git readiness check passed.');
  console.log(`origin: ${runGit(['remote', 'get-url', 'origin']).stdout.trim()}`);
  console.log(`candidate files checked: ${candidateFiles.length}`);
  console.log(status ? 'working tree has changes ready for review.' : 'working tree is clean.');
  if (options.verbose) {
    printVerboseSummary(candidateFiles);
  }
}

main();
