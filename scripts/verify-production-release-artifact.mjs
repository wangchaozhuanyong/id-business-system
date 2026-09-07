#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const options = parseArguments(process.argv.slice(2));
const directory = resolve(options.directory ?? '.');
const manifestPath = resolve(directory, options.manifest ?? 'release-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const shaPattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const regionPattern = /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/u;
const registryPattern = /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/u;
const pinnedImagePattern =
  /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/u;

assert.equal(manifest.schemaVersion, 2, '不支持的发布清单版本');
assert.equal(manifest.delivery, 'aws-ecr', '发布清单不是 ECR 交付');
assert.match(manifest.commit, commitPattern, '发布清单 commit 无效');
assert.equal(manifest.environment, 'production', '发布环境必须为 production');
assert.match(manifest.aws?.region, regionPattern, 'AWS 区域无效');
assert.match(manifest.aws?.ecrRegistry, registryPattern, 'ECR registry 无效');
assert.ok(
  manifest.aws.ecrRegistry.includes(`.ecr.${manifest.aws.region}.amazonaws.com`),
  'ECR registry 与 AWS 区域不匹配'
);
if (options.expectedCommit) {
  assert.equal(manifest.commit, options.expectedCommit, '发布 commit 与预期不一致');
}
if (options.expectedTag) {
  assert.equal(manifest.releaseTag, options.expectedTag, '正式标签与预期不一致');
}

const artifactFile = manifest.artifact?.file;
assert.equal(typeof artifactFile, 'string', '发布清单缺少源码制品文件名');
assert.equal(artifactFile, basename(artifactFile), '源码制品文件名不得包含路径');
assert.match(manifest.artifact.sha256, shaPattern, '源码制品 SHA-256 无效');
assert.equal(
  manifest.artifact.githubArtifactName,
  `id-business-v2-${manifest.releaseTag}-${manifest.commit}`,
  'GitHub 制品名称无效'
);

for (const name of ['api', 'admin', 'migration', 'mediaResolver', 'recharge', 'gate']) {
  const image = manifest.images?.[name];
  assert.equal(typeof image?.taggedReference, 'string', `缺少 ${name} ECR 标签引用`);
  assert.equal(typeof image?.reference, 'string', `缺少 ${name} ECR digest 引用`);
  assert.match(image.digest, digestPattern, `${name} ECR digest 无效`);
  assert.match(image.reference, pinnedImagePattern, `${name} ECR digest 引用无效`);
  assert.ok(
    image.taggedReference.startsWith(`${manifest.aws.ecrRegistry}/`) &&
      image.taggedReference.endsWith(`:${manifest.commit}`),
    `${name} ECR 标签不是当前 commit`
  );
  assert.equal(
    image.reference,
    `${image.taggedReference.slice(0, -(manifest.commit.length + 1))}@${image.digest}`,
    `${name} ECR 引用与 digest 不一致`
  );
  assert.equal(image.platform, 'linux/amd64', `${name} 镜像平台无效`);
}

const artifactPath = resolve(directory, artifactFile);
assert.ok(statSync(artifactPath).isFile(), '源码制品文件不存在');
assert.equal(await sha256File(artifactPath), manifest.artifact.sha256, '源码制品 SHA-256 不一致');

for (const entry of listTar(artifactPath)) {
  assert.ok(!entry.startsWith('/') && !entry.split('/').includes('..'), `源码路径不安全：${entry}`);
  assert.ok(!/^\.git(?:\/|$)/u.test(entry), '源码归档不得包含 .git');
  assert.ok(!/^\.deploy(?:\/|$)/u.test(entry), '源码归档不得包含 .deploy');
  assert.ok(
    !/^\.env(?:$|\.local$|\.production$|\.aws\.production$|.*\.local$)/u.test(entry),
    '源码归档包含真实环境文件'
  );
}

console.log(
  JSON.stringify({
    ok: true,
    delivery: manifest.delivery,
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

async function sha256File(path) {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
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
