#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fetchWithReleasePolicy } from './lib/cloudflare-deployment.mjs';
import {
  RELEASE_BRANCH,
  RELEASE_REPOSITORY,
  createCloudflareRuntimeSecrets,
  createReleaseSubprocessEnvironment,
  parseGitHubRepository,
  validateCloudflareHyperdriveTarget,
  validateGitHubReleaseState,
  validateGitState,
  validateReleaseEnvironment,
  validateCloudflareRemoteSecretNames,
  validateWranglerConfig
} from './lib/cloudflare-release.mjs';
import {
  RELEASE_EVIDENCE_ARTIFACT_FILES,
  validateGitHubBusinessOwnerApproval,
  validateProductionReleaseEvidence,
  validateProductionReleaseEvidenceArtifacts
} from './lib/production-release-evidence.mjs';

runCommand('git', ['fetch', 'origin', RELEASE_BRANCH, '--prune']);

const config = JSON.parse(await readFile('wrangler.cloudflare-free.jsonc', 'utf8'));
const head = readCommand('git', ['rev-parse', 'HEAD']);
const tree = readCommand('git', ['rev-parse', 'HEAD^{tree}']);
const migrationState = await readMigrationState();
const evidencePath = path.resolve('.deploy/release-evidence', `${head}.json`);
const evidenceResult = await readReleaseEvidence(evidencePath);
const artifactResult = await readReleaseEvidenceArtifacts(head);
const trust = JSON.parse(await readFile('deploy/production-release-trust.json', 'utf8'));
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
  ...validateGitHubReleaseState({ checkRuns, protection }),
  ...evidenceResult.errors,
  ...artifactResult.errors
];
if (evidenceResult.evidence) {
  errors.push(
    ...validateProductionReleaseEvidence(evidenceResult.evidence, {
      branch: state.branch,
      commit: state.head,
      env: process.env,
      migrationSetSha256: migrationState.migrationSetSha256,
      migrationWatermark: migrationState.watermark,
      now: new Date(),
      prismaSchemaSha256: migrationState.prismaSchemaSha256,
      repository: state.repository,
      tree,
      trust
    }),
    ...validateProductionReleaseEvidenceArtifacts(evidenceResult.evidence, artifactResult.artifacts)
  );
}

if (errors.length) {
  console.error(`Cloudflare 生产发布预检失败（${errors.length} 项）：`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

verifyGitHubBusinessOwnerApproval(
  evidenceResult.evidence,
  artifactResult.artifacts[RELEASE_EVIDENCE_ARTIFACT_FILES.businessOwnerApproval],
  state
);
const expectedRuntimeSecretNames = Object.keys(createCloudflareRuntimeSecrets(process.env)).sort();
const existingRemoteSecretNames = readRemoteSecretNames();
const remoteSecretErrors = validateCloudflareRemoteSecretNames(
  existingRemoteSecretNames,
  expectedRuntimeSecretNames,
  { allowMissing: true }
);
if (remoteSecretErrors.length) {
  throw new Error(`Cloudflare 远端 secret 预检失败：${remoteSecretErrors.join('；')}`);
}
await verifySupabasePublicCredentials(process.env);
const hyperdriveId = config.hyperdrive.find((item) => item.binding === 'HYPERDRIVE').id;
const hyperdriveErrors = validateCloudflareHyperdriveTarget(
  readHyperdriveConfig(hyperdriveId),
  hyperdriveId,
  process.env.DATABASE_URL,
  process.env.SUPABASE_URL
);
if (hyperdriveErrors.length) {
  throw new Error(`Cloudflare Hyperdrive 目标校验失败：${hyperdriveErrors.join('；')}`);
}
runCommand(
  'npm',
  ['exec', '--', 'prisma', 'migrate', 'status', '--schema', 'apps/api/prisma/schema.prisma'],
  {
    env: createReleaseSubprocessEnvironment(process.env, ['DATABASE_URL'])
  }
);
runCommand(
  'npm',
  [
    'exec',
    '--',
    'prisma',
    'migrate',
    'diff',
    '--exit-code',
    '--from-schema-datasource',
    'apps/api/prisma/schema.prisma',
    '--to-schema-datamodel',
    'apps/api/prisma/schema.prisma'
  ],
  {
    env: createReleaseSubprocessEnvironment(process.env, ['DATABASE_URL'])
  }
);

console.log(
  JSON.stringify(
    {
      ok: true,
      repository: state.repository,
      branch: state.branch,
      commit: state.head,
      evidenceReceiptId: evidenceResult.evidence.receiptId,
      migrationWatermark: migrationState.watermark,
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
    env: options.env ?? createReleaseSubprocessEnvironment(process.env),
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

async function readMigrationState() {
  const entries = await readdir('apps/api/prisma/migrations', {
    withFileTypes: true
  });
  const migrations = entries
    .filter((entry) => entry.isDirectory() && /^\d+_[A-Za-z0-9_]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const watermark = migrations.at(-1);
  if (!watermark) throw new Error('仓库没有可用的 Prisma migration 水位');

  const migrationHash = createHash('sha256');
  for (const migration of migrations) {
    const migrationDirectory = path.join('apps/api/prisma/migrations', migration);
    const files = (await readdir(migrationDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    for (const file of files) {
      migrationHash.update(`${migration}/${file}\0`);
      migrationHash.update(await readFile(path.join(migrationDirectory, file)));
      migrationHash.update('\0');
    }
  }
  const prismaSchema = await readFile('apps/api/prisma/schema.prisma');
  return {
    watermark,
    migrationSetSha256: migrationHash.digest('hex'),
    prismaSchemaSha256: createHash('sha256').update(prismaSchema).digest('hex')
  };
}

async function readReleaseEvidence(evidencePath) {
  try {
    const evidenceStat = await stat(evidencePath);
    if ((evidenceStat.mode & 0o077) !== 0) {
      return {
        evidence: null,
        errors: ['生产发布凭证权限必须为 0600']
      };
    }
    return {
      evidence: JSON.parse(await readFile(evidencePath, 'utf8')),
      errors: []
    };
  } catch {
    return {
      evidence: null,
      errors: [`缺少当前 commit 的生产发布凭证：${evidencePath}`]
    };
  }
}

async function readReleaseEvidenceArtifacts(commit) {
  const artifactsDirectory = path.resolve('.deploy/release-evidence/artifacts', commit);
  const artifacts = {};
  const errors = [];
  for (const filename of Object.values(RELEASE_EVIDENCE_ARTIFACT_FILES)) {
    const artifactPath = path.join(artifactsDirectory, filename);
    try {
      const artifactStat = await lstat(artifactPath);
      if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) {
        errors.push(`生产发布证据附件必须是普通文件：${artifactPath}`);
        continue;
      }
      if ((artifactStat.mode & 0o077) !== 0) {
        errors.push(`生产发布证据附件权限必须为 0600：${artifactPath}`);
        continue;
      }
      if (artifactStat.size <= 0 || artifactStat.size > 5 * 1024 * 1024) {
        errors.push(`生产发布证据附件必须为 1 字节到 5 MiB：${artifactPath}`);
        continue;
      }
      artifacts[filename] = await readFile(artifactPath);
    } catch {
      errors.push(`缺少生产发布证据附件：${artifactPath}`);
    }
  }
  return { artifacts, errors };
}

async function verifySupabasePublicCredentials(env) {
  const supabaseUrl = env.SUPABASE_URL.replace(/\/+$/, '');
  const credentials = new Set(
    [
      env.SUPABASE_PUBLISHABLE_KEY,
      env.SUPABASE_ANON_KEY,
      env.VITE_SUPABASE_PUBLISHABLE_KEY,
      env.VITE_SUPABASE_ANON_KEY
    ].filter(Boolean)
  );
  for (const credential of credentials) {
    let response;
    try {
      response = await fetchWithReleasePolicy(`${supabaseUrl}/auth/v1/settings`, {
        headers: {
          apikey: credential
        }
      });
    } catch {
      throw new Error('无法使用已配置的公开 key 连接目标 Supabase Auth 项目');
    }
    if (!response.ok) {
      throw new Error(`目标 Supabase Auth 拒绝已配置的公开 key，HTTP ${response.status}`);
    }
  }
}

function readHyperdriveConfig(hyperdriveId) {
  const output = readCommand('npx', [
    'wrangler@4.114.0',
    'hyperdrive',
    'get',
    hyperdriveId,
    '--config',
    'wrangler.cloudflare-free.jsonc'
  ]);
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    throw new Error('Cloudflare Hyperdrive 查询未返回 JSON 配置');
  }
  try {
    return JSON.parse(output.slice(jsonStart, jsonEnd + 1));
  } catch {
    throw new Error('Cloudflare Hyperdrive 查询返回无效 JSON');
  }
}

function readRemoteSecretNames() {
  const secrets = readJsonCommand('npx', [
    'wrangler@4.114.0',
    'secret',
    'list',
    '--config',
    'wrangler.cloudflare-free.jsonc',
    '--format',
    'json'
  ]);
  if (
    !Array.isArray(secrets) ||
    secrets.some((secret) => typeof secret?.name !== 'string' || secret.type !== 'secret_text')
  ) {
    throw new Error('Cloudflare 远端 secret 列表格式无效');
  }
  return secrets.map((secret) => secret.name);
}

function verifyGitHubBusinessOwnerApproval(evidence, artifactContent, releaseState) {
  let artifact;
  try {
    artifact = JSON.parse(artifactContent.toString('utf8'));
  } catch {
    throw new Error('业务负责人批准附件无法用于 GitHub 在线核验');
  }
  const reference = new URL(artifact.approvalReference);
  const match = reference.pathname.match(
    /^\/repos\/([^/]+\/[^/]+)\/pulls\/([1-9][0-9]*)\/reviews\/([1-9][0-9]*)$/i
  );
  if (!match || match[1].toLowerCase() !== RELEASE_REPOSITORY.toLowerCase()) {
    throw new Error('业务负责人批准引用不属于当前仓库的 GitHub Review API');
  }
  const pullNumber = Number(match[2]);
  const reviewId = Number(match[3]);
  const review = readJsonCommand('gh', [
    'api',
    `repos/${RELEASE_REPOSITORY}/pulls/${pullNumber}/reviews/${reviewId}`
  ]);
  const pullRequest = readJsonCommand('gh', [
    'api',
    `repos/${RELEASE_REPOSITORY}/pulls/${pullNumber}`
  ]);
  const releaseActor = readJsonCommand('gh', ['api', 'user']);
  const approvalErrors = validateGitHubBusinessOwnerApproval({
    artifact,
    branch: RELEASE_BRANCH,
    commit: releaseState.head,
    evidence,
    pullNumber,
    pullRequest,
    releaseActor,
    repository: RELEASE_REPOSITORY,
    review,
    reviewId
  });
  if (approvalErrors.length) {
    throw new Error(`GitHub 业务负责人批准在线核验失败：${approvalErrors.join('；')}`);
  }
}
