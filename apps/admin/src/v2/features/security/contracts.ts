export type V2SecurityTab = 'login_logs' | 'sessions' | 'policy';
export type V2LoginLogStatus = 'success' | 'failed' | 'blocked';

export interface V2SecurityUser {
  id: string;
  username: string;
  displayName: string;
}

export interface V2SecurityOverview {
  failedLoginCount: number;
  abnormalLoginCount: number;
  activeSessionCount: number;
  pendingApprovalCount: number;
  enabledWhitelistCount: number;
}

export interface V2LoginLogRecord {
  id: string;
  userId?: string | null;
  user?: V2SecurityUser | null;
  username: string;
  status: V2LoginLogStatus;
  failureReason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  location?: string | null;
  abnormal: boolean;
  createdAt: string;
}

export interface V2ActiveSessionRecord {
  id: string;
  userId: string;
  user: V2SecurityUser;
  ip?: string | null;
  userAgent?: string | null;
  lastActiveAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  createdAt: string;
  isCurrent: boolean;
}

export interface V2MfaSettings {
  id?: string | null;
  key: string;
  value: {
    enabled?: boolean;
    requiredForAdmins?: boolean;
    issuer?: string;
    recoveryCodeCount?: number;
  };
  updatedAt?: string | null;
}

export interface V2MfaStatus {
  enabled: boolean;
  configured: boolean;
  recoveryCodeCount: number;
  enabledAt?: string | null;
  lastUsedAt?: string | null;
  disabledAt?: string | null;
}

export interface V2MfaUserRecord extends V2MfaStatus {
  id: string;
  username: string;
  displayName: string;
  status: 'active' | 'disabled';
  roles: string[];
}

export interface V2MfaSetupResult extends V2MfaStatus {
  secret: string;
  otpauthUrl: string;
}

export interface V2MfaRecoveryCodesResult extends V2MfaStatus {
  recoveryCodes: string[];
}

export interface V2UpdateMfaSettingsInput {
  enabled: boolean;
  requiredForAdmins: boolean;
  issuer: string;
}

export interface V2VerifyMfaInput {
  code: string;
}

export interface V2DisableMfaInput extends V2VerifyMfaInput {
  reason?: string;
}

export interface V2IpWhitelistRecord {
  id: string;
  ipOrCidr: string;
  scope: 'admin' | 'api';
  enabled: boolean;
  remark?: string | null;
  createdBy?: V2SecurityUser | null;
  createdAt: string;
  updatedAt: string;
}

export interface V2SaveIpWhitelistInput {
  expectedUpdatedAt?: string;
  ipOrCidr: string;
  scope: 'admin' | 'api';
  enabled: boolean;
  remark?: string;
}

export interface V2PagedResult<TItem> {
  items: TItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface V2LoginLogListQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: V2LoginLogStatus;
  abnormal?: 'true' | 'false';
  sortBy?: 'createdAt' | 'username' | 'status' | 'abnormal' | 'ip';
  sortOrder?: 'asc' | 'desc';
}

export interface V2SessionListQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  revoked?: 'true' | 'false';
  sortBy?: 'createdAt' | 'lastActiveAt' | 'expiresAt' | 'revokedAt' | 'ip';
  sortOrder?: 'asc' | 'desc';
}

export interface V2IpWhitelistListQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  scope?: 'admin' | 'api';
  enabled?: 'true' | 'false';
  sortBy?: 'createdAt' | 'updatedAt' | 'ipOrCidr' | 'scope' | 'enabled';
  sortOrder?: 'asc' | 'desc';
}

export interface V2MfaUserListQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
}
