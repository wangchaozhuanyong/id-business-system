#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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

assert.equal(manifest.schemaVersion, 1, '不支持的发布清单版本');
assert.match(manifest.commit, commitPattern, '发布清单 commit 无效');
assert.equal(manifest.environment, 'production', '发布环境必须为 production');
if (options.expectedCommit) {
  assert.equal(manifest.commit, options.expectedCommit, '发布 commit 与预期不一致');
}
if (options.expectedTag) {
  assert.equal(manifest.releaseTag, options.expectedTag, '正式标签与预期不一致');
}

const artifactFile = manifest.artifact?.file;
assert.equal(typeof artifactFile, 'string', '发布清单缺少制品文件名');
assert.equal(artifactFile, basename(artifactFile), '制品文件名不得包含路径');
assert.match(manifest.artifact.sha256, shaPattern, '制品 SHA-256 无效');
assert.match(manifest.artifact.imageArchiveSha256, shaPattern, '镜像归档 SHA-256 无效');
assert.match(manifest.artifact.sourceArchiveSha256, shaPattern, '源码归档 SHA-256 无效');

for (const name of ['api', 'admin', 'migration', 'gate']) {
  assert.equal(typeof manifest.images?.[name]?.reference, 'string', `缺少 ${name} 镜像引用`);
  assert.match(manifest.images[name].digest, digestPattern, `${name} 镜像 digest 无效`);
}

const artifactPath = resolve(directory, artifactFile);
assert.ok(statSync(artifactPath).isFile(), '发布制品文件不存在');
assert.equal(sha256File(artifactPath), manifest.artifact.sha256, '发布制品 SHA-256 不一致');

const entries = listTar(artifactPath);
assert.deepEqual(entries.sort(), ['images.tar', 'source.tar.gz'], '发布制品内容不符合约定');
const extractionDirectory = mkdtempSync(join(tmpdir(), 'idv2-release-verify-'));

try {
  run('tar', ['-xzf', artifactPath, '-C', extractionDirectory]);
  const imageArchive = join(extractionDirectory, 'images.tar');
  const sourceArchive = join(extractionDirectory, 'source.tar.gz');
  assert.equal(
    sha256File(imageArchive),
    manifest.artifact.imageArchiveSha256,
    '镜像归档 SHA-256 不一致'
  );
  assert.equal(
    sha256File(sourceArchive),
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
    imageDigests: Object.fromEntries(
      Object.entries(manifest.images).map(([name, value]) => [name, value.digest])
    )
  })
);

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

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function listTar(path) {
  const result = run('tar', ['-tzf', path]);
  return result
    .split(/\r?\n/u)
    .map((entry) => entry.replace(/^\.\//u, ''))
    .filter(Boolean);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 执行失败：${result.stderr.trim()}`);
  }
  return result.stdout;
}
