import { NEW_SYSTEM_BACKUP_PROFILE } from '../id-business-v2-new-backup-coverage';

export interface BackupIdentity {
  profile: typeof NEW_SYSTEM_BACKUP_PROFILE;
  id: string;
  sourceId: string;
  kind: 'full' | 'incremental' | 'attachments';
  schemaSha256: string;
  previousId?: string;
  boundary?: { stream: string; start: string; end: string };
}
export interface BackupBlob {
  identity: BackupIdentity;
  filename: string;
  size: number;
  sha256: string;
  md5: string;
}
export interface BackupUploadState {
  version: 1;
  blob: BackupBlob;
  folderId: string;
  phase: 'ready' | 'uploading' | 'verified';
  fileId?: string;
  sessionEncrypted?: string;
  offset: number;
  failures: number;
  retryAt: number;
  errorCode?: string;
  verifiedAt?: string;
  verifiedVersion?: string;
}
export interface BackupStateCodec {
  encrypt(value: string): string | null;
  decrypt(value: string): string | null;
}
// The host must hold an exclusive OS/process lease for this outbox, including on restart.
export interface BackupLease {
  assertCurrent(): Promise<void>;
}
export class BackupError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs = 0
  ) {
    super(code);
    this.name = 'BackupError';
  }
}
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const SHA256 = /^[a-f0-9]{64}$/;
export function validateBackupIdentity(value: BackupIdentity) {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).some(
      (key) =>
        !['profile', 'id', 'sourceId', 'kind', 'schemaSha256', 'previousId', 'boundary'].includes(
          key
        )
    )
  )
    throw new BackupError('BACKUP_IDENTITY_INVALID');
  if (
    value.profile !== NEW_SYSTEM_BACKUP_PROFILE ||
    !UUID.test(value.id) ||
    !UUID.test(value.sourceId) ||
    !['full', 'incremental', 'attachments'].includes(value.kind) ||
    !SHA256.test(value.schemaSha256) ||
    (value.previousId !== undefined &&
      (!UUID.test(value.previousId) || value.previousId === value.id))
  )
    throw new BackupError('BACKUP_IDENTITY_INVALID');
  if (
    value.boundary &&
    (Object.keys(value.boundary).length !== 3 ||
      !['stream', 'start', 'end'].every(
        (key) =>
          typeof value.boundary![key as keyof typeof value.boundary] === 'string' &&
          /^[A-Za-z0-9_.:,-]{1,4096}$/.test(value.boundary![key as keyof typeof value.boundary])
      ))
  )
    throw new BackupError('BACKUP_BOUNDARY_INVALID');
  if (value.kind === 'incremental' && (!value.previousId || !value.boundary))
    throw new BackupError('BACKUP_INCREMENTAL_BOUNDARY_REQUIRED');
}

export function copyBackupIdentity(value: BackupIdentity): BackupIdentity {
  validateBackupIdentity(value);
  return {
    profile: value.profile,
    id: value.id,
    sourceId: value.sourceId,
    kind: value.kind,
    schemaSha256: value.schemaSha256,
    ...(value.previousId !== undefined ? { previousId: value.previousId } : {}),
    ...(value.boundary
      ? {
          boundary: {
            stream: value.boundary.stream,
            start: value.boundary.start,
            end: value.boundary.end
          }
        }
      : {})
  };
}
