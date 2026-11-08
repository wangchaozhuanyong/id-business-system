import { BackupError, type BackupUploadState } from './backup-types';
import { createHash } from 'node:crypto';
import type { BackupTransferBudget } from './backup-transfer-budget';

const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FIELDS = 'id,size,sha256Checksum,md5Checksum,parents,appProperties,trashed,version';
export interface BackupRemoteFile {
  version?: string;
  id?: string;
  size?: string;
  sha256Checksum?: string;
  md5Checksum?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
  trashed?: boolean;
}
export class BackupDriveClient {
  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly http: typeof fetch = fetch,
    private readonly transferBudget?: BackupTransferBudget
  ) {}

  async generateId() {
    const response = await this.request(`${FILES}/generateIds?count=1&space=drive&type=files`);
    const data = await this.json<{ ids?: unknown[] }>(response);
    const id = data.ids?.[0];
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(id))
      throw new BackupError('BACKUP_DRIVE_ID_INVALID');
    return id;
  }
  async metadata(id: string): Promise<BackupRemoteFile | null> {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) throw new BackupError('BACKUP_DRIVE_ID_INVALID');
    const response = await this.request(
      `${FILES}/${encodeURIComponent(id)}?fields=${FIELDS}&supportsAllDrives=true`,
      {},
      [404]
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    return this.json<BackupRemoteFile>(response);
  }
  async start(state: BackupUploadState) {
    const response = await this.request(
      `${UPLOAD}?uploadType=resumable&supportsAllDrives=true&fields=${FIELDS}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': 'application/octet-stream',
          'X-Upload-Content-Length': String(state.blob.size)
        },
        body: JSON.stringify({
          id: state.fileId,
          name: `${state.blob.identity.kind}-${state.blob.filename}`,
          mimeType: 'application/octet-stream',
          parents: [state.folderId],
          appProperties: this.properties(state)
        })
      }
    );
    const session = response.headers.get('location');
    await response.body?.cancel();
    this.validateSession(session);
    return session!;
  }
  async progress(session: string, total: number) {
    this.validateSession(session);
    return this.request(
      session,
      {
        method: 'PUT',
        headers: { 'Content-Length': '0', 'Content-Range': `bytes */${total}` },
        body: new Uint8Array()
      },
      [308, 404, 410]
    );
  }
  async chunk(session: string, offset: number, total: number, bytes: Uint8Array) {
    this.validateSession(session);
    await this.transferBudget?.take(bytes.byteLength);
    return this.request(
      session,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.byteLength),
          'Content-Range': `bytes ${offset}-${offset + bytes.byteLength - 1}/${total}`
        },
        body: bytes as BodyInit
      },
      [308, 404, 410]
    );
  }
  offset(response: Response, total: number) {
    if (response.status === 200 || response.status === 201) return total;
    const range = response.headers.get('range');
    if (response.status !== 308) throw new BackupError('BACKUP_SESSION_EXPIRED');
    if (!range) return 0;
    const match = /^bytes=0-([0-9]+)$/.exec(range);
    const offset = match ? Number(match[1]) + 1 : NaN;
    if (!Number.isSafeInteger(offset) || offset < 1 || offset > total)
      throw new BackupError('BACKUP_ACK_INVALID');
    return offset;
  }
  async verify(state: BackupUploadState, remote: BackupRemoteFile | null) {
    const properties = this.properties(state);
    if (
      !remote ||
      remote.id !== state.fileId ||
      remote.trashed ||
      remote.size !== String(state.blob.size) ||
      !Array.isArray(remote.parents) ||
      !remote.parents.includes(state.folderId) ||
      Object.entries(properties).some(([key, value]) => remote.appProperties?.[key] !== value)
    )
      throw new BackupError('BACKUP_REMOTE_VERIFICATION_FAILED');
    let digest = remote.sha256Checksum;
    if (
      digest === undefined &&
      state.phase === 'verified' &&
      state.verifiedVersion &&
      remote.version === state.verifiedVersion &&
      remote.md5Checksum === state.blob.md5
    ) {
      // Reuse a prior SHA proof only while Drive's read-only content version is unchanged.
      digest = state.blob.sha256;
    }
    if (digest === undefined) {
      // Drive documents this field as optional. Verify the actual encrypted bytes if absent.
      const response = await this.request(
        `${FILES}/${encodeURIComponent(state.fileId!)}?alt=media&supportsAllDrives=true`
      );
      const hash = createHash('sha256');
      let size = 0;
      for await (const part of this.body(response, state.blob.size)) {
        if (this.transferBudget) {
          for (let offset = 0; offset < part.length; offset += 1_048_576)
            await this.transferBudget.take(Math.min(1_048_576, part.length - offset));
        }
        size += part.length;
        hash.update(part);
      }
      if (size !== state.blob.size) throw new BackupError('BACKUP_REMOTE_VERIFICATION_FAILED');
      digest = hash.digest('hex');
    }
    if (digest !== state.blob.sha256) throw new BackupError('BACKUP_REMOTE_VERIFICATION_FAILED');
    return typeof remote.version === 'string' && /^[0-9]{1,20}$/.test(remote.version)
      ? remote.version
      : undefined;
  }
  private properties(state: BackupUploadState) {
    return {
      profile: state.blob.identity.profile,
      batch: state.blob.identity.id,
      source: state.blob.identity.sourceId,
      sha256: state.blob.sha256
    };
  }
  private validateSession(value: unknown) {
    try {
      if (typeof value !== 'string' || value.length > 8192) throw new Error();
      const url = new URL(value);
      if (
        url.origin !== 'https://www.googleapis.com' ||
        url.pathname !== '/upload/drive/v3/files' ||
        url.username ||
        url.password ||
        url.hash ||
        url.searchParams.get('uploadType') !== 'resumable' ||
        !url.searchParams.get('upload_id')
      )
        throw new Error();
    } catch {
      throw new BackupError('BACKUP_SESSION_URL_INVALID');
    }
  }
  private async json<T>(response: Response): Promise<T> {
    const parts: Uint8Array[] = [];
    try {
      for await (const part of this.body(response, 65_536)) parts.push(part);
      return JSON.parse(Buffer.concat(parts).toString('utf8')) as T;
    } catch {
      throw new BackupError('BACKUP_RESPONSE_INVALID');
    }
  }
  private async *body(response: Response, maxBytes: number) {
    const reader = response.body?.getReader();
    if (!reader) throw new BackupError('BACKUP_RESPONSE_INVALID');
    let size = 0;
    try {
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new BackupError('BACKUP_RESPONSE_TIMEOUT'));
            void reader.cancel().catch(() => undefined);
          }, 30_000);
        });
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await Promise.race([reader.read(), timeout]);
        } finally {
          clearTimeout(timer);
        }
        if (next.done) break;
        size += next.value.length;
        if (size > maxBytes) throw new BackupError('BACKUP_RESPONSE_TOO_LARGE');
        yield next.value;
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  }
  private async request(url: string, init: RequestInit = {}, allowed: number[] = []) {
    const abort = new AbortController(),
      timer = setTimeout(() => abort.abort(), 30_000);
    try {
      const token = await this.accessToken();
      const response = await this.http(url, {
        ...init,
        redirect: 'error',
        signal: abort.signal,
        headers: { ...init.headers, Authorization: `Bearer ${token}` }
      });
      if (response.ok || allowed.includes(response.status)) return response;
      const header = response.headers.get('retry-after');
      const retry =
        header && /^\d+$/.test(header)
          ? Number(header) * 1000
          : header
            ? Date.parse(header) - Date.now()
            : 0;
      await response.body?.cancel();
      throw new BackupError(
        `BACKUP_GOOGLE_HTTP_${response.status}`,
        Number.isFinite(retry) ? Math.max(0, Math.min(retry, 86_400_000)) : 0
      );
    } catch (error) {
      if (error instanceof BackupError) throw error;
      throw new BackupError('BACKUP_GOOGLE_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  }
}
