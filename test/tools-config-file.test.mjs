import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readToolConfig } from '../server/tools/read-tool-config.mjs';

const analytics = 'website-analytics';
const visits = 'website-visits';
const microsoft = 'microsoft-mailbox';
const syntheticMarker = 'synthetic-config-contents-must-not-leak';

async function fixtures(t) {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(runtime, 'tools-config-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function file(dir, name, content, mode = 0o600) {
  const path = join(dir, name);
  await writeFile(path, content, { flag: 'wx', mode });
  await chmod(path, mode);
  return path;
}

test('three startup inputs load from owner-only files and only an omitted option is disabled', async (t) => {
  const dir = await fixtures(t);
  const ga4 = {
    propertyId: '100',
    streamId: '200',
    hosts: ['example.test'],
    serviceAccount: { type: 'service_account' }
  };
  const ms = {
    clientId: 'synthetic',
    clientSecret: syntheticMarker,
    redirectUri: 'http://127.0.0.1:9901/callback'
  };
  const gaFile = await file(dir, 'ga4.json', JSON.stringify(ga4), 0o400);
  const msFile = await file(dir, 'microsoft.json', JSON.stringify(ms));
  const visitsFile = await file(dir, 'visits.txt', '  ' + syntheticMarker + '\n');
  assert.deepEqual(await readToolConfig(gaFile, analytics), ga4);
  assert.deepEqual(await readToolConfig(msFile, microsoft), ms);
  assert.equal(await readToolConfig(visitsFile, visits), syntheticMarker);
  assert.equal(await readToolConfig(undefined, visits), undefined);
  await assert.rejects(readToolConfig('', visits), /无法安全读取/);
  await assert.rejects(readToolConfig(join(dir, 'missing.json'), analytics), /无法安全读取/);
});

test('overbroad mode, wrong ownership, non-regular files and linked paths are rejected', async (t) => {
  const dir = await fixtures(t);
  const good = await file(dir, 'approved.json', '{}');
  for (const mode of [0o640, 0o604, 0o660, 0o700, 0o200]) {
    await chmod(good, mode);
    await assert.rejects(readToolConfig(good, analytics), /无法安全读取/);
  }
  await chmod(good, 0o600);
  const owner = process.geteuid();
  const uidMock = t.mock.method(process, 'geteuid', () => owner + 1);
  try {
    await assert.rejects(readToolConfig(good, analytics), /无法安全读取/);
  } finally {
    uidMock.mock.restore();
  }
  const soft = join(dir, 'linked.json');
  await symlink(good, soft);
  await assert.rejects(readToolConfig(soft, analytics), /无法安全读取/);
  const alias = join(dir, 'alias-dir');
  await symlink(dir, alias);
  await assert.rejects(readToolConfig(join(alias, 'approved.json'), analytics), /无法安全读取/);
  const hard = join(dir, 'hard-linked.json');
  await link(good, hard);
  await assert.rejects(readToolConfig(hard, analytics), /无法安全读取/);
  await assert.rejects(readToolConfig(good, analytics), /无法安全读取/);
  await assert.rejects(readToolConfig(dir, analytics), /无法安全读取/);
  const fifo = join(dir, 'fixture-fifo');
  execFileSync('mkfifo', ['-m', '600', fifo]);
  await assert.rejects(readToolConfig(fifo, analytics), /无法安全读取/);
});

test('standard Google credential files use the deployed FLASH CAST report source', async (t) => {
  const dir = await fixtures(t);
  const credential = { type: 'service_account', client_email: 'synthetic@example.iam.gserviceaccount.com' };
  const path = await file(dir, 'service-account.json', JSON.stringify(credential));
  assert.deepEqual(await readToolConfig(path, analytics), {
    propertyId: '540413787',
    streamId: '15010607367',
    hosts: ['flashcast.com.my', 'www.flashcast.com.my'],
    serviceAccount: credential
  });

  const partialSource = { ...credential, propertyId: '100' };
  const partialPath = await file(dir, 'partial-source.json', JSON.stringify(partialSource));
  assert.deepEqual(await readToolConfig(partialPath, analytics), partialSource);
});

test('invalid payloads and oversized files fail without disclosing config paths, contents or causes', async (t) => {
  const dir = await fixtures(t);
  for (const [index, [content, kind, message]] of [
    ['{"private_key":"' + syntheticMarker, analytics, /格式无效/],
    ['[]', microsoft, /格式无效/],
    ['null', analytics, /格式无效/],
    ['short', visits, /格式无效/],
    [syntheticMarker + '\n' + syntheticMarker, visits, /格式无效/],
    [Buffer.from([0xff]), microsoft, /无法安全读取/],
    [Buffer.alloc(64 * 1024 + 1, 'a'), analytics, /无法安全读取/]
  ].entries()) {
    const path = await file(dir, 'sensitive-file-' + index, content);
    await assert.rejects(readToolConfig(path, kind), (error) => {
      assert.match(error.message, message);
      assert.ok(!error.message.includes(path));
      assert.ok(!error.message.includes(syntheticMarker));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test(
  'macOS ACLs granting additional access are rejected even with mode 0600',
  {
    skip: process.platform !== 'darwin'
  },
  async (t) => {
    const dir = await fixtures(t);
    const path = await file(dir, 'acl.json', '{}');
    execFileSync('chmod', ['+a', 'everyone allow read', path]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(readToolConfig(path, analytics), /无法安全读取/);
  }
);
