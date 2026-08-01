import type { CurrentUser } from '@/types/system';

export const AUTH_CREDENTIAL_STORAGE_KEY = 'apple_business_auth_v2';
export const LEGACY_TOKEN_STORAGE_KEY = 'apple_business_access_token';
export const LEGACY_CURRENT_USER_STORAGE_KEY = 'apple_business_current_user';

export interface StoredCredentialV2 {
  credentialId: string;
  schemaVersion: 2;
  token: string;
  tokenRevision: number;
  updatedAt: number;
  userCache: CurrentUser | null;
}

export interface CredentialSnapshot {
  credentialId: string;
  token: string;
  tokenRevision: number;
}

export function createStoredCredential(
  token: string,
  userCache: CurrentUser | null
): StoredCredentialV2 {
  return {
    credentialId: createCredentialId(),
    schemaVersion: 2,
    token,
    tokenRevision: 1,
    updatedAt: Date.now(),
    userCache
  };
}

export function readStoredCredential(): StoredCredentialV2 | null {
  const storage = getCredentialStorage();
  if (!storage) return null;
  const stored = readJson(AUTH_CREDENTIAL_STORAGE_KEY);
  if (isStoredCredentialV2(stored)) {
    clearLegacyCredentialKeys();
    return stored;
  }
  if (stored !== null) storage.removeItem(AUTH_CREDENTIAL_STORAGE_KEY);

  const legacyToken = storage.getItem(LEGACY_TOKEN_STORAGE_KEY)?.trim() ?? '';
  const legacyUserValue = readJson(LEGACY_CURRENT_USER_STORAGE_KEY);
  const legacyUser = isCurrentUser(legacyUserValue) ? legacyUserValue : null;
  clearLegacyCredentialKeys();
  if (!legacyToken || !legacyUser) return null;

  const migrated = createStoredCredential(legacyToken, legacyUser);
  writeStoredCredential(migrated);
  return migrated;
}

export function writeStoredCredential(credential: StoredCredentialV2) {
  const storage = getCredentialStorage();
  if (!storage) return false;
  storage.setItem(AUTH_CREDENTIAL_STORAGE_KEY, JSON.stringify(credential));
  clearLegacyCredentialKeys();
  return true;
}

export function clearStoredCredential(expected?: { credentialId: string; tokenRevision?: number }) {
  const storage = getCredentialStorage();
  if (!storage) return true;
  const stored = readJson(AUTH_CREDENTIAL_STORAGE_KEY);
  if (expected && isStoredCredentialV2(stored)) {
    if (stored.credentialId !== expected.credentialId) return false;
    if (expected.tokenRevision !== undefined && stored.tokenRevision !== expected.tokenRevision) {
      return false;
    }
  }
  storage.removeItem(AUTH_CREDENTIAL_STORAGE_KEY);
  clearLegacyCredentialKeys();
  return true;
}

export function toCredentialSnapshot(
  credential: StoredCredentialV2 | null
): CredentialSnapshot | null {
  return credential
    ? {
        credentialId: credential.credentialId,
        token: credential.token,
        tokenRevision: credential.tokenRevision
      }
    : null;
}

export function isSameCredentialSnapshot(
  credential: StoredCredentialV2 | null,
  snapshot: CredentialSnapshot | null | undefined
) {
  return Boolean(
    credential &&
    snapshot &&
    credential.credentialId === snapshot.credentialId &&
    credential.tokenRevision === snapshot.tokenRevision
  );
}

export function isCurrentUser(value: unknown): value is CurrentUser {
  if (!value || typeof value !== 'object') return false;
  const user = value as CurrentUser;
  return (
    typeof user.id === 'string' &&
    typeof user.username === 'string' &&
    typeof user.displayName === 'string' &&
    Array.isArray(user.roles) &&
    user.roles.every((role) => typeof role === 'string') &&
    Array.isArray(user.permissions) &&
    user.permissions.every((permission) => typeof permission === 'string') &&
    typeof user.mustResetPassword === 'boolean'
  );
}

function isStoredCredentialV2(value: unknown): value is StoredCredentialV2 {
  if (!value || typeof value !== 'object') return false;
  const credential = value as StoredCredentialV2;
  return (
    credential.schemaVersion === 2 &&
    typeof credential.credentialId === 'string' &&
    Boolean(credential.credentialId) &&
    typeof credential.token === 'string' &&
    Boolean(credential.token) &&
    Number.isInteger(credential.tokenRevision) &&
    credential.tokenRevision > 0 &&
    Number.isFinite(credential.updatedAt) &&
    (credential.userCache === null || isCurrentUser(credential.userCache))
  );
}

function readJson(key: string) {
  const storage = getCredentialStorage();
  if (!storage) return null;
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return Symbol.for('invalid-json');
  }
}

function clearLegacyCredentialKeys() {
  const storage = getCredentialStorage();
  if (!storage) return;
  storage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
  storage.removeItem(LEGACY_CURRENT_USER_STORAGE_KEY);
}

function getCredentialStorage(): Storage | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function createCredentialId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `credential-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
