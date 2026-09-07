#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const options = parseArguments(process.argv.slice(2));
const directory = resolve(options.directory ?? '.');
const manifestPath = resolve(directory, options.manifest ?? 'release-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const shaPattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const releaseTagPattern = /^v2-production-[0-9]{8}T[0-9]{6}Z$/u;

assert.ok([1, 2].includes(manifest.schemaVersion), '不支持的发布清单版本');
assert.match(manifest.commit, commitPattern, '发布清单 commit 无效');
assert.match(manifest.releaseTag, releaseTagPattern, '发布清单正式标签无效');
assert.equal(manifest.environment, 'production', '发布环境必须为 production');
if (options.expectedCommit) {
  assert.equal(manifest.commit, options.expectedCommit, '发布 commit 与预期不一致');
}
if (options.expectedTag) {
  assert.equal(manifest.releaseTag, options.expectedTag, '正式标签与预期不一致');
}
if (manifest.schemaVersion === 2) {
  assert.equal(manifest.sourceBranch, 'main', '发布源码分支必须是 main');
  assert.equal(manifest.ciWorkflow, 'Production Release Artifact', '发布制品工作流无效');
  assert.match(manifest.previousCommit, commitPattern, '上一生产 commit 无效');
  assert.notEqual(
    manifest.previousCommit,
    manifest.commit,
    '发布 commit 与上一生产 commit 不得相同'
  );
  assert.ok(['fresh', 'recent'].includes(manifest.risk?.backupPolicy), '备份风险策略无效');
  assert.equal(typeof manifest.risk?.migrationRequired, 'boolean', 'migration 风险标记无效');
  assert.ok(
    Array.isArray(manifest.acceptanceScopes) && manifest.acceptanceScopes.includes('base'),
    '发布清单缺少全店基础验收'
  );
  assert.ok(Array.isArray(manifest.changedImages), '发布清单缺少受影响镜像列表');
  const allowedAcceptanceScopes = new Set([
    'base',
    'admin',
    'api',
    'auth',
    'auto-recharge',
    'database',
    'finance',
    'gateway',
    'media-resolver',
    'workspace',
    'runtime-config'
  ]);
  for (const scope of manifest.acceptanceScopes) {
    assert.ok(allowedAcceptanceScopes.has(scope), `未知发布验收范围：${scope}`);
  }
  assert.equal(
    manifest.artifact?.githubArtifactName,
    `id-business-v2-${manifest.releaseTag}-${manifest.commit}-control`,
    '控制制品 GitHub 名称无效'
  );
  if (manifest.risk.migrationRequired) {
    assert.equal(manifest.risk.backupPolicy, 'fresh', 'migration 发布必须强制新备份');
    assert.ok(manifest.acceptanceScopes.includes('database'), 'migration 发布缺少数据库验收范围');
  }
}

const artifactFile = manifest.artifact?.file;
assert.equal(typeof artifactFile, 'string', '发布清单缺少制品文件名');
assert.equal(artifactFile, basename(artifactFile), '制品文件名不得包含路径');
if (manifest.schemaVersion === 2) {
  assert.equal(
    artifactFile,
    `id-business-v2-${manifest.releaseTag}-${manifest.commit}-source.tar.gz`,
    '源码控制制品文件名无效'
  );
}
assert.match(manifest.artifact.sha256, shaPattern, '制品 SHA-256 无效');
assert.match(manifest.artifact.sourceArchiveSha256, shaPattern, '源码归档 SHA-256 无效');

for (const name of ['api', 'admin', 'migration', 'mediaResolver', 'recharge', 'gate']) {
  assert.equal(typeof manifest.images?.[name]?.reference, 'string', `缺少 ${name} 镜像引用`);
  assert.match(manifest.images[name].digest, digestPattern, `${name} 镜像 digest 无效`);
  if (manifest.schemaVersion === 2) validateIncrementalImage(name, manifest.images[name], manifest);
}
if (manifest.schemaVersion === 2) {
  const expectedChangedImages = Object.entries(manifest.images)
    .filter(([, image]) => !image.inherited)
    .map(([name]) => name);
  assert.deepEqual(manifest.changedImages, expectedChangedImages, '受影响镜像列表与继承标记不一致');
}

const artifactPath = resolve(directory, artifactFile);
assert.ok(statSync(artifactPath).isFile(), '发布制品文件不存在');
assert.equal(await sha256File(artifactPath), manifest.artifact.sha256, '发布制品 SHA-256 不一致');

const entries = listTar(artifactPath);
assert.deepEqual(
  entries.sort(),
  manifest.schemaVersion === 1 ? ['images.tar', 'source.tar.gz'] : ['source.tar.gz'],
  '发布制品内容不符合约定'
);
const extractionDirectory = mkdtempSync(join(tmpdir(), 'idv2-release-verify-'));

try {
  run('tar', ['-xzf', artifactPath, '-C', extractionDirectory]);
  const sourceArchive = join(extractionDirectory, 'source.tar.gz');
  if (manifest.schemaVersion === 1) {
    const imageArchive = join(extractionDirectory, 'images.tar');
    assert.match(manifest.artifact.imageArchiveSha256, shaPattern, '镜像归档 SHA-256 无效');
    assert.equal(
      await sha256File(imageArchive),
      manifest.artifact.imageArchiveSha256,
      '镜像归档 SHA-256 不一致'
    );
  }
  assert.equal(
    await sha256File(sourceArchive),
    manifest.artifact.sourceArchiveSha256,
    '源码归档 SHA-256 不一致'
  );

  for (const entry of listTar(sourceArchive)) {
    assert.ok(
      !entry.startsWith('/') && !entry.split('/').includes('..'),
      `源码路径不安全：${entry}`
    );
    assert.ok(!/^\.git(?:\/|$)/u.test(entry), '源码归档不得包含 .git');
    assert.ok(!/^\.deploy(?:\/|$)/u.test(entry), '源码归档不得包含 .deploy');
    assert.ok(
      !/^\.env(?:$|\.local$|\.production$|\.aws\.production$|.*\.local$)/u.test(entry),
      '源码归档包含真实环境文件'
    );
  }

  if (manifest.schemaVersion === 2 && options.metadataOnly !== 'true') {
    for (const [name, image] of Object.entries(manifest.images)) {
      const archivePath = resolve(directory, image.archive.file);
      if (image.inherited && !isFile(archivePath)) continue;
      assert.ok(isFile(archivePath), `${name} 镜像归档不存在`);
      assert.equal(await sha256File(archivePath), image.archive.sha256, `${name} 镜像归档损坏`);
    }
  }
} finally {
  rmSync(extractionDirectory, { recursive: true, force: true });
}

console.log(
  JSON.stringify({
    ok: true,
    commit: manifest.commit,
    releaseTag: manifest.releaseTag,
    artifactFile,
    artifactSha256: manifest.artifact.sha256,
    schemaVersion: manifest.schemaVersion,
    changedImages:
      manifest.schemaVersion === 2 ? manifest.changedImages : Object.keys(manifest.images),
    imageDigests: Object.fromEntries(
      Object.entries(manifest.images).map(([name, value]) => [name, value.digest])
    )
  })
);

function validateIncrementalImage(name, image, manifest) {
  assert.ok(Number.isSafeInteger(image.sizeBytes) && image.sizeBytes > 0, `${name} 镜像大小无效`);
  assert.equal(typeof image.inherited, 'boolean', `${name} 镜像继承标记无效`);
  const referenceName = name === 'mediaResolver' ? 'media-resolver' : name;
  assert.equal(
    image.reference,
    `id-business-v2-release-${referenceName}:${image.archive.sourceCommit}`,
    `${name} 镜像引用与来源 commit 不一致`
  );
  assert.equal(image.archive.file, basename(image.archive.file), `${name} 镜像归档文件名无效`);
  assert.match(image.archive.file, /^image-[A-Za-z-]+-[a-f0-9]{40}\.tar\.gz$/u);
  assert.match(image.archive.sha256, shaPattern, `${name} 镜像归档 SHA-256 无效`);
  assert.equal(typeof image.archive.githubArtifactName, 'string', `${name} 镜像缺少 GitHub 制品名`);
  assert.match(String(image.archive.ciWorkflowRunId), /^[0-9]+$/u, `${name} 镜像 CI 运行号无效`);
  assert.match(image.archive.sourceCommit, commitPattern, `${name} 镜像来源 commit 无效`);
  assert.match(image.archive.sourceReleaseTag, releaseTagPattern, `${name} 镜像来源标签无效`);
  assert.equal(
    image.archive.githubArtifactName,
    `id-business-v2-${image.archive.sourceReleaseTag}-${image.archive.sourceCommit}-image-${name}`,
    `${name} 镜像 GitHub 制品名无效`
  );
  assert.equal(
    image.archive.file,
    `image-${name}-${image.archive.sourceCommit}.tar.gz`,
    `${name} 镜像归档与来源 commit 不一致`
  );
  if (!image.inherited) {
    assert.equal(image.archive.sourceCommit, manifest.commit, `${name} 新镜像来源 commit 无效`);
    assert.equal(image.archive.sourceReleaseTag, manifest.releaseTag, `${name} 新镜像来源标签无效`);
    assert.equal(
      String(image.archive.ciWorkflowRunId),
      String(manifest.ciWorkflowRunId),
      `${name} 新镜像 CI 运行号无效`
    );
  }
}

function parseArguments(argumentsList) {
  const parsed = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const value = argumentsList[index];
    if (!value.startsWith('--')) throw new Error(`未知参数：${value}`);
    const key = value.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    const next = argumentsList[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`参数缺少值：${value}`);
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function listTar(path) {
  const result = run('tar', ['-tzf', path]);
  return result
    .split(/\r?\n/u)
    .map((entry) => entry.replace(/^\.\//u, ''))
    .filter(Boolean);
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 执行失败：${result.stderr.trim()}`);
  }
  return result.stdout;
}
