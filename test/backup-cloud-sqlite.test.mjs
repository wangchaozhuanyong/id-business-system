import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBackupDrive } from '../server/backup/cloud-drive.mjs';
import { createCloudBackupWorker } from '../server/backup/cloud-worker.mjs';
import { unpackSnapshot } from '../server/backup/cloud-archive.mjs';
import { restoreSnapshot } from '../server/backup/local-sqlite.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { startPreview } from '../server/preview.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const parent = 'synthetic_backup_root';
const folder = 'synthetic_full_folder';
const oauth = { clientId: 'synthetic-id', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh' };

async function fixture(t) {
  const base = join(root, 'backups');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const path = await mkdtemp(join(base, '.sqlite-cloud-test-'));
  t.after(() => rm(path, { force: true, recursive: true }));
  return path;
}

test('Drive verifies the configured parent before sending a file', async () => {
  const requests = [];
  const drive = createBackupDrive({ oauth, root: parent, folder, fetchImpl: async (url, init) => {
    requests.push([String(url), init.method]);
    if (String(url).startsWith('https://oauth2.googleapis.com/'))
      return Response.json({ access_token: 'synthetic', expires_in: 3600 });
    return Response.json({
      id: folder, mimeType: 'application/vnd.google-apps.folder',
      parents: ['another_project_folder'], capabilities: { canAddChildren: true }
    });
  } });
  await assert.rejects(drive.uploadBatch({ remoteId: 'synthetic_file_id' }, '/not-opened'),
    { message: 'DRIVE_FOLDER_UNAVAILABLE' });
  assert.equal(requests.length, 2);
  assert.equal(requests[1][1], undefined);
});

test('Drive reuses the reserved ID after a lost success response and verifies downloaded bytes', async (t) => {
  const dir = await fixture(t);
  const path = join(dir, 'opaque.fixture');
  const bytes = Buffer.from('synthetic opaque backup bytes');
  await writeFile(path, bytes, { mode: 0o600 });
  const batch = { batch: randomUUID(), source: randomUUID(), remoteId: 'synthetic_file_id',
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  let metadata, uploads = 0, download = 0;
  const drive = createBackupDrive({ oauth, root: parent, folder, fetchImpl: async (url, init) => {
    const endpoint = new URL(url);
    if (endpoint.hostname === 'oauth2.googleapis.com')
      return Response.json({ access_token: 'synthetic', expires_in: 3600 });
    if (endpoint.pathname.endsWith(folder)) return Response.json({
      id: folder, mimeType: 'application/vnd.google-apps.folder', parents: [parent],
      capabilities: { canAddChildren: true }
    });
    if (endpoint.pathname.endsWith(batch.remoteId)) {
      if (endpoint.searchParams.get('alt') === 'media') {
        download++;
        return new Response(bytes);
      }
      return metadata ? Response.json(metadata) : new Response(null, { status: 404 });
    }
    if (init.method === 'POST') {
      assert.equal(JSON.parse(init.body).id, batch.remoteId);
      return new Response(null, { headers: {
        location: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=synthetic'
      } });
    }
    if (init.method === 'PUT') {
      uploads++;
      assert.deepEqual(init.body, bytes);
      metadata = { id: batch.remoteId, parents: [folder], size: String(bytes.length),
        appProperties: { format: 'independent-sqlite-v1', source: batch.source, batch: batch.batch } };
      throw new Error('synthetic lost success response');
    }
    throw new Error('unrecognized synthetic request');
  } });
  await assert.rejects(drive.uploadBatch(batch, path), /lost success/);
  await drive.uploadBatch(batch, path);
  assert.equal(uploads, 1);
  assert.equal(download, 1);
  await assert.rejects(drive.uploadBatch({ ...batch, sha256: '0'.repeat(64) }, path),
    { message: 'DRIVE_REMOTE_BYTES_MISMATCH' });
});

test('isolated SQLite worker restores archived business data and resumes interrupted uploads',
  { skip: process.env.GITHUB_ACTIONS !== 'true' }, async (t) => {
    const dir = await fixture(t);
    const dataDir = join(dir, 'source');
    const outbox = join(dir, 'outbox');
    await mkdir(dataDir, { mode: 0o700 });
    await mkdir(outbox, { mode: 0o700 });
    const db = join(dataDir, 'local-business.sqlite');
    const store = createLocalBusinessStore(db);
    t.after(() => store.close());
    await chmod(db, 0o600);
    const actor = { id: 'fixture-actor', name: '合成操作员' };
    store.saveToolbox({ version: 0, data: { shortcuts: [], phrases: [] } }, actor);
    store.saveBatch([{ domain: 'commerce', version: 0, action: '新增客户',
      data: { customers: [{ id: 'synthetic-1', name: '合成客户' }], orders: [], tenants: [],
        operating: [], rentBatches: [], logs: [] } }]);
    const site = await startPreview(0, { databasePath: db });
    t.after(() => new Promise((resolve, reject) =>
      site.server.close((error) => error ? reject(error) : resolve())));
    async function readSite() {
      const durations = [];
      for (let round = 0; round < 24; round++) {
        await Promise.all(['inventory', 'commerce'].map(async (domain) => {
          const started = performance.now();
          const response = await fetch(site.url + 'api/local/' + domain, { signal: AbortSignal.timeout(3000) });
          assert.equal(response.status, 200);
          await response.arrayBuffer();
          durations.push(performance.now() - started);
        }));
      }
      return Math.round(durations.sort((a, b) => a - b)[Math.ceil(durations.length * 0.95) - 1] * 10) / 10;
    }
    const baseline = await readSite();
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const config = { dataDir, outbox, source: randomUUID(),
      recipient: publicKey.export({ type: 'spki', format: 'pem' }) };
    let reservations = 0;
    const uploaded = new Map();
    const drive = {
      preflight: async () => undefined,
      reserveId: async () => 'synthetic_remote_id_' + ++reservations,
      uploadBatch: async (batch, path) => {
        if (!uploaded.has(batch.remoteId)) {
          uploaded.set(batch.remoteId, await readFile(path));
          if (reservations === 1) throw new Error('synthetic disconnect');
        }
      }
    };
    const first = await createCloudBackupWorker({ ...config, drive });
    try { await assert.rejects(first.tick(), /synthetic disconnect/); } finally { first.close(); }
    const worker = await createCloudBackupWorker({ ...config, drive });
    try {
      assert.equal((await worker.tick()).captured, true);
      assert.equal(reservations, 1);
      // Establish the restart's read connection version before the next committed mutation.
      await worker.tick();
      const before = reservations;
      store.saveToolbox({ version: 1, data: { shortcuts: [], phrases: [] } }, actor);
      const [result, withCapture] = await Promise.all([worker.tick(), readSite()]);
      assert.equal(result.captured, true);
      t.diagnostic(JSON.stringify({ scope: 'synthetic CI read-only fixture', baselineP95Ms: baseline,
        captureP95Ms: withCapture, samplesPerPhase: 48 }));
      assert.equal(reservations, before + 1);
      const downloaded = join(dir, 'downloaded.idbackup');
      await writeFile(downloaded, [...uploaded.values()].at(-1), { mode: 0o600 });
      const snapshot = join(dir, 'unpacked');
      const verified = await unpackSnapshot({ input: downloaded, output: snapshot, key: privateKey });
      assert.ok(verified.documents >= 2);
      await restoreSnapshot({ input: snapshot, output: join(dir, 'restored'), key: db + '.key' });
      const restored = createLocalBusinessStore(join(dir, 'restored', 'local-business.sqlite'));
      try {
        assert.equal(restored.load('commerce').data.customers[0].name, '合成客户');
      } finally { restored.close(); }
      const wrongKey = generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey;
      await assert.rejects(unpackSnapshot({ input: downloaded, output: join(dir, 'wrong'), key: wrongKey }),
        { message: 'BACKUP_ARCHIVE_RECOVERY_FAILED' });
    } finally { worker.close(); }
  });
