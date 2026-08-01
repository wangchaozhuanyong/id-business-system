export interface V2ProfileRole {
  code: string;
  name: string;
}

export interface V2ProfileRecord {
  id: string;
  username: string;
  displayName: string;
  emailMasked?: string | null;
  phoneMasked?: string | null;
  status: 'active';
  roles: V2ProfileRole[];
  mustResetPassword: boolean;
  lastAuthenticatedAt?: string | null;
  lastLoginAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface V2ProfileSessionUser {
  id: string;
  username: string;
  displayName: string;
}

export interface V2ProfileSessionRecord {
  id: string;
  userId: string;
  user: V2ProfileSessionUser;
  ip?: string | null;
  userAgent?: string | null;
  lastActiveAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  createdAt: string;
  isCurrent: boolean;
}

export interface V2ProfileMfaStatus {
  enabled: boolean;
  configured: boolean;
  recoveryCodeCount: number;
  enabledAt?: string | null;
  lastUsedAt?: string | null;
  disabledAt?: string | null;
}

export interface V2ProfileMfaSetupResult extends V2ProfileMfaStatus {
  secret: string;
  otpauthUrl: string;
}

export interface V2ProfileMfaRecoveryCodesResult extends V2ProfileMfaStatus {
  recoveryCodes: string[];
}

export interface V2ProfilePagedResult<TItem> {
  items: TItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface V2ProfileBootstrap {
  profile: V2ProfileRecord;
  mfaStatus: V2ProfileMfaStatus;
  sessions: V2ProfilePagedResult<V2ProfileSessionRecord>;
  generatedAt: string;
}

export interface V2ProfileSessionListQuery {
  page?: number;
  pageSize?: number;
}
