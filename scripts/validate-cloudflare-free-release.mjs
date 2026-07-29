#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import {
  RELEASE_BRANCH,
  RELEASE_REPOSITORY,
  parseGitHubRepository,
  validateGitHubReleaseState,
  validateGitState,
  validateReleaseEnvironment,
  validateWranglerConfig
} from './lib/cloudflare-release.mjs';

runCommand('git', ['fetch', 'origin', RELEASE_BRANCH, '--prune']);

const config = JSON.parse(await readFile('wrangler.cloudflare-free.jsonc', 'utf8'));
const head = readCommand('git', ['rev-parse', 'HEAD']);
const state = {
  repository: parseGitHubRepository(readCommand('git', ['remote', 'get-url', 'origin'])),
  branch: readCommand('git', ['branch', '--show-current']),
  status: readCommand('git', ['status', '--porcelain=v1']),
  head,
  originHead: readCommand('git', ['rev-parse', `origin/${RELEASE_BRANCH}`])
};
const checkRuns = readJsonCommand('gh', [
  'api',
  `repos/${RELEASE_REPOSITORY}/commits/${head}/check-runs`
]).check_runs;
const protection = readJsonCommand('gh', [
  'api',
  `repos/${RELEASE_REPOSITORY}/branches/${RELEASE_BRANCH}/protection`
]);
const errors = [
  ...validateReleaseEnvironment(process.env),
  ...validateWranglerConfig(config),
  ...validateGitState(state),
  ...validateGitHubReleaseState({ checkRuns, protection })
];

if (errors.length) {
  console.error(`Cloudflare 生产发布预检失败（${errors.length} 项）：`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      repository: state.repository,
      branch: state.branch,
      commit: state.head,
      worker: config.name,
      accountId: config.account_id,
      publicUrl: config.vars.APP_PUBLIC_URL
    },
    null,
    2
  )
);

function readCommand(command, args) {
  return runCommand(command, args, { capture: true }).stdout.trim();
}

function readJsonCommand(command, args) {
  const output = readCommand(command, args);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${command} 返回了无效 JSON`);
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit'
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = options.capture ? result.stderr.trim() : '';
    throw new Error(`${command} 执行失败${detail ? `：${detail}` : ''}`);
  }
  return result;
}
