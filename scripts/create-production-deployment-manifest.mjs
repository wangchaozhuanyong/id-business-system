#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const options = parseArguments(process.argv.slice(2));
for (const name of [
  'input',
  'output',
  'deploymentRun',
  'deployedAt',
  'operator',
  'previousCommit',
  'githubArtifactId',
  'githubArtifactName',
  'githubArtifactDigest',
  'githubRunUrl'
]) {
  assert.ok(options[name], `缺少发布清单参数 --${toKebabCase(name)}`);
}

const inputPath = resolve(options.input);
const outputPath = resolve(options.output);
const manifest = JSON.parse(readFileSync(inputPath, 'utf8'));
const commitPattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^(?:sha256:)?[a-f0-9]{64}$/u;

assert.equal(manifest.schemaVersion, 1, '不支持的 CI 发布清单版本');
assert.match(manifest.commit, commitPattern, 'CI 发布清单 commit 无效');
assert.match(options.previousCommit, commitPattern, '上一生产 commit 无效');
assert.match(options.githubArtifactDigest, sha256Pattern, 'GitHub 制品 digest 无效');
assert.equal(
  options.githubArtifactName,
  basename(options.githubArtifactName),
  'GitHub 制品名不得包含路径'
);
assert.equal(manifest.environment, 'production', '发布环境必须为 production');
assert.equal(manifest.deploymentRun, null, 'CI 发布清单已被部署信息污染');
assert.equal(manifest.deployedAt, null, 'CI 发布清单已包含部署时间');
assert.equal(manifest.previousCommit, null, 'CI 发布清单已包含上一版本');

const deploymentManifest = {
  ...manifest,
  deploymentRun: options.deploymentRun,
  deployedAt: options.deployedAt,
  operator: options.operator,
  previousCommit: options.previousCommit,
  githubArtifact: {
    id: options.githubArtifactId,
    name: options.githubArtifactName,
    digest: options.githubArtifactDigest.startsWith('sha256:')
      ? options.githubArtifactDigest
      : `sha256:${options.githubArtifactDigest}`,
    workflowRunUrl: options.githubRunUrl
  }
};

writeFileSync(outputPath, `${JSON.stringify(deploymentManifest, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600
});
console.log(
  JSON.stringify({
    ok: true,
    commit: deploymentManifest.commit,
    releaseTag: deploymentManifest.releaseTag,
    deploymentRun: deploymentManifest.deploymentRun,
    artifactSha256: deploymentManifest.artifact.sha256
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

function toKebabCase(value) {
  return value.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}
