#!/usr/bin/env node
import { createPublicKey } from 'node:crypto';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  RELEASE_EVIDENCE_ARTIFACT_FILES,
  createReleaseEvidenceIntegrity,
  validateProductionReleaseEvidenceArtifacts,
  validateProductionReleaseTrust
} from './lib/production-release-evidence.mjs';

const evidencePath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const privateKeyPath = process.env.PRODUCTION_RELEASE_EVIDENCE_PRIVATE_KEY_FILE
  ? path.resolve(process.env.PRODUCTION_RELEASE_EVIDENCE_PRIVATE_KEY_FILE)
  : null;
const keyId = process.env.PRODUCTION_RELEASE_EVIDENCE_KEY_ID?.trim();

if (!evidencePath || !privateKeyPath || !keyId) {
  throw new Error(
    '用法: PRODUCTION_RELEASE_EVIDENCE_PRIVATE_KEY_FILE=<0600-key> PRODUCTION_RELEASE_EVIDENCE_KEY_ID=<key-id> node scripts/sign-production-release-evidence.mjs <receipt.json>'
  );
}

const privateKeyStat = await stat(privateKeyPath);
if ((privateKeyStat.mode & 0o077) !== 0) {
  throw new Error('生产发布凭证私钥权限必须为 0600');
}

const [evidenceContent, privateKey, trustContent] = await Promise.all([
  readFile(evidencePath, 'utf8'),
  readFile(privateKeyPath, 'utf8'),
  readFile('deploy/production-release-trust.json', 'utf8')
]);
const evidence = JSON.parse(evidenceContent);
const trust = JSON.parse(trustContent);
const trustErrors = validateProductionReleaseTrust(trust);
if (trustErrors.length) {
  throw new Error(`生产发布信任配置无效：${trustErrors.join('；')}`);
}
const trustedKey = trust.keys.find((key) => key.keyId === keyId && key.status === 'active');
if (!trustedKey) {
  throw new Error('指定 keyId 不在受保护代码的生产发布信任配置中');
}
const derivedPublicKey = createPublicKey(privateKey)
  .export({ format: 'pem', type: 'spki' })
  .toString()
  .trim();
const trustedPublicKey = createPublicKey(trustedKey.publicKey)
  .export({ format: 'pem', type: 'spki' })
  .toString()
  .trim();
if (derivedPublicKey !== trustedPublicKey) {
  throw new Error('生产发布私钥与受保护代码中的受信任公钥不匹配');
}

const artifactsDirectory = path.resolve(
  path.dirname(evidencePath),
  'artifacts',
  evidence.release?.commit ?? ''
);
const artifacts = Object.fromEntries(
  await Promise.all(
    Object.values(RELEASE_EVIDENCE_ARTIFACT_FILES).map(async (filename) => [
      filename,
      await readFile(path.join(artifactsDirectory, filename))
    ])
  )
);
const artifactErrors = validateProductionReleaseEvidenceArtifacts(evidence, artifacts);
if (artifactErrors.length) {
  throw new Error(`生产发布证据附件无效：${artifactErrors.join('；')}`);
}
evidence.integrity = createReleaseEvidenceIntegrity(evidence, privateKey, keyId);

await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600
});
await chmod(evidencePath, 0o600);

console.log(
  JSON.stringify(
    {
      ok: true,
      keyId,
      receiptId: evidence.receiptId
    },
    null,
    2
  )
);
