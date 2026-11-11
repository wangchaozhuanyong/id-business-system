import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

const files = 'https://www.googleapis.com/drive/v3/files';
const upload = 'https://www.googleapis.com/upload/drive/v3/files';
const tokenUrl = 'https://oauth2.googleapis.com/token';
const fields = 'id,parents,size,sha256Checksum,trashed,appProperties';
const chunkSize = 1024 * 1024;
const folderId = /^[A-Za-z0-9_-]{10,200}$/;

export class CloudBackupError extends Error {}
const fail = (code) => new CloudBackupError(code);

async function json(response) {
  const parts = [];
  let size = 0;
  if (!response.body) throw fail('DRIVE_RESPONSE_INVALID');
  for await (const part of response.body) {
    size += part.length;
    if (size > 64 * 1024) throw fail('DRIVE_RESPONSE_INVALID');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export function createGoogleBackupRequest({ oauth, fetchImpl = fetch }) {
  if (![oauth?.clientId, oauth?.clientSecret, oauth?.refreshToken]
    .every((value) => typeof value === 'string' && value.trim() && value.length <= 8192))
    throw fail('DRIVE_AUTH_CONFIG_INVALID');
  let access;
  async function token() {
    if (access?.until > Date.now()) return access.value;
    const response = await fetchImpl(tokenUrl, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: oauth.clientId, client_secret: oauth.clientSecret,
        refresh_token: oauth.refreshToken, grant_type: 'refresh_token' })
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw fail('DRIVE_AUTH_UNAVAILABLE');
    }
    const result = await json(response);
    if (typeof result.access_token !== 'string' || !result.access_token ||
        !Number.isFinite(result.expires_in) || result.expires_in < 1)
      throw fail('DRIVE_AUTH_INVALID');
    access = { value: result.access_token, until: Date.now() + Math.max(0, result.expires_in - 60) * 1000 };
    return access.value;
  }
  async function request(url, init = {}, allowed = []) {
    const response = await fetchImpl(url, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { ...init.headers, authorization: 'Bearer ' + await token() }
    });
    if (response.status === 401) access = undefined;
    if (!response.ok && !allowed.includes(response.status)) {
      await response.body?.cancel();
      throw fail('DRIVE_HTTP_' + response.status);
    }
    return response;
  }
  return request;
}

export function createBackupDrive({ oauth, root, folder, fetchImpl = fetch }) {
  if (![root, folder].every((id) => typeof id === 'string' && folderId.test(id)) || root === folder)
    throw fail('DRIVE_FOLDER_INVALID');
  const request = createGoogleBackupRequest({ oauth, fetchImpl });

  async function preflight() {
    const data = await json(await request(
      `${files}/${folder}?supportsAllDrives=true&fields=id,mimeType,parents,trashed,capabilities(canAddChildren)`
    ));
    if (data.id !== folder || data.mimeType !== 'application/vnd.google-apps.folder' ||
        data.trashed || !Array.isArray(data.parents) || !data.parents.includes(root) ||
        data.capabilities?.canAddChildren !== true) throw fail('DRIVE_FOLDER_UNAVAILABLE');
  }
  async function reserveId() {
    const data = await json(await request(files + '/generateIds?count=1&space=drive&type=files'));
    const id = data.ids?.[0];
    if (typeof id !== 'string' || !folderId.test(id)) throw fail('DRIVE_ID_INVALID');
    return id;
  }
  async function metadata(id) {
    const response = await request(`${files}/${id}?supportsAllDrives=true&fields=${fields}`, {}, [404]);
    if (response.status !== 404) return json(response);
    await response.body?.cancel();
    return null;
  }
  function properties(batch) {
    return { format: 'independent-sqlite-v1', source: batch.source, batch: batch.batch };
  }
  async function verify(batch, remote) {
    if (remote?.id !== batch.remoteId || remote.trashed || remote.size !== String(batch.size) ||
        !Array.isArray(remote.parents) || !remote.parents.includes(folder) ||
        Object.entries(properties(batch)).some(([key, value]) => remote.appProperties?.[key] !== value))
      throw fail('DRIVE_REMOTE_IDENTITY_MISMATCH');
    let sha = remote.sha256Checksum;
    if (!sha) {
      const response = await request(`${files}/${batch.remoteId}?alt=media&supportsAllDrives=true`);
      const hash = createHash('sha256');
      let size = 0;
      if (!response.body) throw fail('DRIVE_REMOTE_BYTES_MISMATCH');
      for await (const part of response.body) {
        size += part.length;
        if (size > batch.size) throw fail('DRIVE_REMOTE_BYTES_MISMATCH');
        hash.update(part);
      }
      if (size !== batch.size) throw fail('DRIVE_REMOTE_BYTES_MISMATCH');
      sha = hash.digest('hex');
    }
    if (sha !== batch.sha256) throw fail('DRIVE_REMOTE_BYTES_MISMATCH');
  }
  async function uploadBatch(batch, path) {
    await preflight();
    if (!folderId.test(batch.remoteId)) throw fail('DRIVE_ID_INVALID');
    const existing = await metadata(batch.remoteId);
    if (existing) return verify(batch, existing);
    const response = await request(upload + '?uploadType=resumable&supportsAllDrives=true', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-upload-content-type': 'application/octet-stream',
        'x-upload-content-length': String(batch.size) },
      body: JSON.stringify({ id: batch.remoteId, name: `新版SQLite全量-${batch.batch}.idbackup`,
        mimeType: 'application/octet-stream', parents: [folder], appProperties: properties(batch) })
    });
    const location = response.headers.get('location');
    await response.body?.cancel();
    const session = new URL(location ?? '', upload);
    if (session.origin !== 'https://www.googleapis.com' || session.pathname !== '/upload/drive/v3/files' ||
        session.username || session.password || session.hash ||
        session.searchParams.get('uploadType') !== 'resumable' || !session.searchParams.get('upload_id'))
      throw fail('DRIVE_SESSION_INVALID');
    const input = await open(path, 'r');
    try {
      let offset = 0;
      while (offset < batch.size) {
        const bytes = Buffer.alloc(Math.min(chunkSize, batch.size - offset));
        if ((await input.read(bytes, 0, bytes.length, offset)).bytesRead !== bytes.length)
          throw fail('DRIVE_LOCAL_FILE_CHANGED');
        const part = await request(session, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length),
            'content-range': `bytes ${offset}-${offset + bytes.length - 1}/${batch.size}` },
          body: bytes
        }, [308]);
        const expected = offset + bytes.length;
        const confirmed = part.status !== 308 ? batch.size :
          Number(/^bytes=0-(\d+)$/.exec(part.headers.get('range') ?? '')?.[1]) + 1;
        await part.body?.cancel();
        if (confirmed !== expected || (part.status === 308) !== (confirmed < batch.size))
          throw fail('DRIVE_UPLOAD_ACK_INVALID');
        offset = confirmed;
        // Bound steady upload work to roughly 2 MiB/s even on a fast connection.
        if (offset < batch.size) await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      await input.close();
    }
    await verify(batch, await metadata(batch.remoteId));
  }
  return { preflight, reserveId, uploadBatch };
}
