#!/usr/bin/env node

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { publicKeyFingerprint } from './lib/production-backup.mjs';

const args = parseArgs(process.argv.slice(2));
if (process.platform !== 'darwin') {
  throw new Error('生产恢复私钥初始化只允许在已核验的 macOS 运维机执行');
}
const privateKeyPath = path.resolve(args.privateKey);
const expectedPrivateRoot = path.resolve(args.allowedPrivateRoot);
await mkdir(expectedPrivateRoot, { recursive: true, mode: 0o700 });
const actualPrivateRoot = await realpath(expectedPrivateRoot);
if (actualPrivateRoot !== expectedPrivateRoot) throw new Error('私钥目录不得经过符号链接');
if (!privateKeyPath.startsWith(`${expectedPrivateRoot}${path.sep}`)) {
  throw new Error('私钥必须保存到指定 .deploy 目录');
}
const publicKeyPath = path.resolve(args.publicKey);
const passphrase = randomBytes(48).toString('base64url');
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem',
    cipher: 'aes-256-cbc',
    passphrase
  }
});

await writeFile(privateKeyPath, privateKey, { flag: 'wx', mode: 0o400 });
await chmod(privateKeyPath, 0o400);
try {
  await addToKeychain(args.keychainAccount, args.keychainService, passphrase);
} catch (error) {
  throw new Error(`私钥已生成，但写入 macOS Keychain 失败：${error.message}`, { cause: error });
}
await writeFile(publicKeyPath, publicKey, { flag: 'wx', mode: 0o644 });

console.log(
  JSON.stringify(
    {
      ok: true,
      privateKey: privateKeyPath,
      publicKey: publicKeyPath,
      publicKeySha256: publicKeyFingerprint(publicKey),
      keychainService: args.keychainService,
      keychainAccount: args.keychainAccount,
      privateKeyEncrypted: true,
      passphrasePrinted: false
    },
    null,
    2
  )
);

function parseArgs(values) {
  const result = {
    privateKey: undefined,
    publicKey: undefined,
    allowedPrivateRoot: undefined,
    keychainService: 'id-business-v2-production-backup',
    keychainAccount: process.env.USER || 'production-operator'
  };
  for (const value of values) {
    if (value.startsWith('--private-key='))
      result.privateKey = value.slice('--private-key='.length);
    else if (value.startsWith('--public-key=')) {
      result.publicKey = value.slice('--public-key='.length);
    } else if (value.startsWith('--allowed-private-root=')) {
      result.allowedPrivateRoot = value.slice('--allowed-private-root='.length);
    } else if (value.startsWith('--keychain-service=')) {
      result.keychainService = value.slice('--keychain-service='.length);
    } else if (value.startsWith('--keychain-account=')) {
      result.keychainAccount = value.slice('--keychain-account='.length);
    } else throw new Error(`未知参数：${value}`);
  }
  if (!result.privateKey || !result.publicKey || !result.allowedPrivateRoot) {
    throw new Error('必须提供私钥、公钥和允许的私钥目录');
  }
  return result;
}

function addToKeychain(account, service, passphrase) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'security',
      ['add-generic-password', '-U', '-a', account, '-s', service, '-w', passphrase],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(stderr.trim() || `security 退出码 ${code ?? 'unknown'}`));
    });
  });
}
