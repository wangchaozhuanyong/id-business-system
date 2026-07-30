#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  PRODUCTION_RELEASE_LOCK_REF,
  assertReleaseStillOwnsActiveVersion,
  createProductionReleaseLockAcquireArguments,
  createProductionReleaseLockReleaseArguments,
  createWranglerRollbackArguments,
  getDeploymentGitCommit,
  getReleaseFailureRecovery,
  getRemoteProductionReleaseLockCommit,
  getWranglerDeployVersionId,
  getSoleActiveVersionId
} from './lib/cloudflare-deployment.mjs';
import {
  createCloudflareProductionBuildEnvironment,
  createCloudflareRuntimeSecrets,
  createReleaseSubprocessEnvironment,
  validateCloudflareRemoteSecretNames
} from './lib/cloudflare-release.mjs';

const externalCommandEnvironment = createReleaseSubprocessEnvironment(process.env);
const commit = (await capture('git', ['rev-parse', 'HEAD'])).trim();
const wranglerCommand = 'wrangler@4.114.0';
const wranglerConfig = 'wrangler.cloudflare-free.jsonc';
const releaseLockCommit = await acquireProductionReleaseLock(commit);

let deploymentError;
let deploymentResult;
try {
  deploymentResult = await deploy(commit, releaseLockCommit);
} catch (error) {
  deploymentError = error;
}

try {
  await releaseProductionReleaseLock(releaseLockCommit);
} catch (lockError) {
  if (deploymentError) {
    throw new AggregateError(
      [deploymentError, lockError],
      '生产发布失败，且远端发布锁未能安全释放；确认没有运行中的发布后人工处置锁',
      { cause: lockError }
    );
  }
  throw lockError;
}
if (deploymentError) throw deploymentError;

console.log(JSON.stringify(deploymentResult, null, 2));

async function deploy(releaseCommit, leaseCommit) {
  await assertProductionReleaseLockOwned(leaseCommit);
  await run('node', ['scripts/validate-cloudflare-free-release.mjs']);

  const config = JSON.parse(await readFile(wranglerConfig, 'utf8'));
  const authAuditEnvironment = createReleaseSubprocessEnvironment(process.env, [
    'DATABASE_URL',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SECRET_KEY'
  ]);
  const smokeEnvironment = createReleaseSubprocessEnvironment(process.env, [
    'SMOKE_TEST_USERNAME',
    'SMOKE_TEST_PASSWORD',
    'SMOKE_TEST_MFA_TOTP_SECRET',
    'SUPABASE_URL',
    'VITE_SUPABASE_ANON_KEY',
    'VITE_SUPABASE_PUBLISHABLE_KEY'
  ]);
  const shortCommit = releaseCommit.slice(0, 12);

  await run('npm', ['run', 'build:cloudflare-free'], {
    env: createCloudflareProductionBuildEnvironment(process.env)
  });
  await run('npm', ['run', 'audit:supabase-auth-readiness', '--', '--summary-only'], {
    env: authAuditEnvironment
  });
  await run('node', ['scripts/validate-cloudflare-free-release.mjs']);
  await assertProductionReleaseLockOwned(leaseCommit);

  const rollbackDeployment = await readActiveDeployment();
  const rollbackVersionId = getSoleActiveVersionId(rollbackDeployment);
  await assertActiveDeploymentIsAncestor(rollbackDeployment, releaseCommit);
  const runtimeSecretsDirectory = await mkdtemp(
    path.join(tmpdir(), 'id-business-cloudflare-secrets-')
  );
  const runtimeSecretsPath = path.join(runtimeSecretsDirectory, 'runtime-secrets.json');
  const wranglerOutputPath = path.join(runtimeSecretsDirectory, 'wrangler-output.jsonl');
  const runtimeSecrets = createCloudflareRuntimeSecrets(process.env);

  let deployedVersionId;
  try {
    await writeFile(runtimeSecretsPath, `${JSON.stringify(runtimeSecrets)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    try {
      await assertProductionReleaseLockOwned(leaseCommit);
      const latestDeployment = await readActiveDeployment();
      if (latestDeployment.id !== rollbackDeployment.id) {
        throw new Error('获取发布锁后 Cloudflare 部署记录发生变化，已在上传前停止');
      }
      assertReleaseStillOwnsActiveVersion(
        getSoleActiveVersionId(latestDeployment),
        rollbackVersionId
      );
      await assertActiveDeploymentIsAncestor(latestDeployment, releaseCommit);

      await run(
        'npx',
        [
          wranglerCommand,
          'deploy',
          '--config',
          wranglerConfig,
          '--strict',
          '--secrets-file',
          runtimeSecretsPath,
          '--message',
          `git:${releaseCommit} branch:main`,
          '--tag',
          `git-${shortCommit}`
        ],
        {
          env: {
            ...externalCommandEnvironment,
            WRANGLER_OUTPUT_FILE_PATH: wranglerOutputPath
          }
        }
      );
      deployedVersionId = getWranglerDeployVersionId(await readFile(wranglerOutputPath, 'utf8'));
      const activeVersionId = await readActiveVersionId();
      assertReleaseStillOwnsActiveVersion(activeVersionId, deployedVersionId);
      await verifyRemoteSecretNames(Object.keys(runtimeSecrets));
      await assertProductionReleaseLockOwned(leaseCommit);
      await run('node', ['scripts/validate-cloudflare-free-release.mjs']);
      await run(
        'node',
        ['scripts/verify-cloudflare-free-deployment.mjs', config.vars.APP_PUBLIC_URL],
        { env: smokeEnvironment }
      );
      assertReleaseStillOwnsActiveVersion(await readActiveVersionId(), deployedVersionId);
    } catch (releaseError) {
      const activeVersionId = await readActiveVersionId().catch((statusError) => {
        throw new AggregateError(
          [releaseError, statusError],
          '发布失败且无法确认当前线上版本，未执行自动回滚',
          { cause: statusError }
        );
      });

      if (!deployedVersionId) {
        if (activeVersionId === rollbackVersionId) {
          throw new Error('发布未完成，线上仍为发布前版本', {
            cause: releaseError
          });
        }
        throw new Error('发布结果归属不明确，已停止自动回滚并转人工处置', {
          cause: releaseError
        });
      }

      const recovery = getReleaseFailureRecovery(
        activeVersionId,
        deployedVersionId,
        rollbackVersionId
      );
      if (recovery.action === 'manual-investigation') {
        throw new AggregateError(
          [releaseError, new Error('线上活跃版本已被其他发布替换，当前发布不再拥有线上版本')],
          `发布失败且线上已切换到 ${activeVersionId}；未执行自动回滚，请人工核对`,
          { cause: releaseError }
        );
      }

      const manualRollbackArguments = createWranglerRollbackArguments(
        recovery.rollbackVersionId,
        wranglerConfig,
        `Manual rollback after failed smoke for git:${releaseCommit}`
      );
      throw new Error(
        `发布后验收失败，自动回滚已禁用；线上仍为本次版本 ${recovery.activeVersionId}，人工回滚目标为 ${recovery.rollbackVersionId}。确认当前活跃版本后执行：${formatCommand(
          ['npx', wranglerCommand, ...manualRollbackArguments]
        )}`,
        {
          cause: releaseError
        }
      );
    }
  } finally {
    await rm(runtimeSecretsDirectory, {
      recursive: true,
      force: true
    });
  }

  return {
    ok: true,
    commit: releaseCommit,
    worker: config.name,
    publicUrl: config.vars.APP_PUBLIC_URL,
    smokeVerified: true
  };
}

async function acquireProductionReleaseLock(releaseCommit) {
  const now = new Date();
  const leaseCommit = (
    await capture('git', ['commit-tree', `${releaseCommit}^{tree}`, '-p', releaseCommit], {
      env: {
        ...externalCommandEnvironment,
        GIT_AUTHOR_NAME: 'ID Business Production Release Lock',
        GIT_AUTHOR_EMAIL: 'release-lock@id-business.invalid',
        GIT_AUTHOR_DATE: now.toISOString(),
        GIT_COMMITTER_NAME: 'ID Business Production Release Lock',
        GIT_COMMITTER_EMAIL: 'release-lock@id-business.invalid',
        GIT_COMMITTER_DATE: now.toISOString()
      },
      input: `ID Business production release lock\n\nlease=${randomUUID()}\nrelease=${releaseCommit}\n`
    })
  ).trim();

  try {
    await run('git', createProductionReleaseLockAcquireArguments(leaseCommit), {
      env: externalCommandEnvironment
    });
  } catch (error) {
    const currentLock = await readRemoteProductionReleaseLock().catch(() => '');
    throw new Error(
      currentLock
        ? `已有生产发布占用远端锁 ${PRODUCTION_RELEASE_LOCK_REF}；确认没有运行中的发布后再人工清理`
        : '无法获取远端生产发布锁，未开始构建或上传',
      { cause: error }
    );
  }
  await assertProductionReleaseLockOwned(leaseCommit);
  return leaseCommit;
}

async function releaseProductionReleaseLock(leaseCommit) {
  await run('git', createProductionReleaseLockReleaseArguments(leaseCommit), {
    env: externalCommandEnvironment
  });
  const currentLock = await readRemoteProductionReleaseLock();
  if (currentLock) {
    throw new Error('远端生产发布锁释放后仍然存在，必须人工核对');
  }
}

async function assertProductionReleaseLockOwned(leaseCommit) {
  const currentLock = await readRemoteProductionReleaseLock();
  if (currentLock !== leaseCommit) {
    throw new Error('当前进程不再持有远端生产发布锁，已停止发布');
  }
}

async function readRemoteProductionReleaseLock() {
  return getRemoteProductionReleaseLockCommit(
    await capture('git', ['ls-remote', '--refs', 'origin', PRODUCTION_RELEASE_LOCK_REF])
  );
}

async function assertActiveDeploymentIsAncestor(deployment, releaseCommit) {
  const activeCommit = getDeploymentGitCommit(deployment);
  if (!(await isGitAncestor(activeCommit, releaseCommit))) {
    throw new Error(
      `Cloudflare 当前部署 commit ${activeCommit} 不是本次 ${releaseCommit} 的祖先，已拒绝用旧提交覆盖线上`
    );
  }
}

function isGitAncestor(ancestor, descendant) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: process.cwd(),
      env: externalCommandEnvironment,
      stdio: 'ignore'
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (!signal && code === 0) {
        resolve(true);
        return;
      }
      if (!signal && code === 1) {
        resolve(false);
        return;
      }
      reject(
        new Error(
          `git merge-base 执行失败${signal ? `，信号 ${signal}` : `，退出码 ${code ?? 'unknown'}`}`
        )
      );
    });
  });
}

function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: options.env ?? externalCommandEnvironment,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit']
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0 && !signal) {
        resolve(output);
        return;
      }
      reject(new Error(`${command} 执行失败${signal ? `，信号 ${signal}` : `，退出码 ${code}`}`));
    });
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: options.env ?? process.env,
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0 && !signal) {
        resolve();
        return;
      }
      reject(new Error(`${command} 执行失败${signal ? `，信号 ${signal}` : `，退出码 ${code}`}`));
    });
  });
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label}不是有效 JSON`);
  }
}

async function readActiveVersionId() {
  return getSoleActiveVersionId(await readActiveDeployment());
}

async function readActiveDeployment() {
  const deployment = parseJson(
    await capture('npx', [
      wranglerCommand,
      'deployments',
      'status',
      '--config',
      wranglerConfig,
      '--json'
    ]),
    'Cloudflare 当前部署状态'
  );
  getSoleActiveVersionId(deployment);
  return deployment;
}

async function verifyRemoteSecretNames(expectedNames) {
  const secrets = parseJson(
    await capture('npx', [
      wranglerCommand,
      'secret',
      'list',
      '--config',
      wranglerConfig,
      '--format',
      'json'
    ]),
    'Cloudflare 远端 secret 列表'
  );
  if (
    !Array.isArray(secrets) ||
    secrets.some((secret) => typeof secret?.name !== 'string' || secret.type !== 'secret_text')
  ) {
    throw new Error('Cloudflare 远端 secret 列表格式无效');
  }
  const errors = validateCloudflareRemoteSecretNames(
    secrets.map((secret) => secret.name),
    expectedNames
  );
  if (errors.length) {
    throw new Error(`Cloudflare 远端 secret 校验失败：${errors.join('；')}`);
  }
}

function formatCommand(parts) {
  return parts.map((part) => JSON.stringify(String(part))).join(' ');
}
