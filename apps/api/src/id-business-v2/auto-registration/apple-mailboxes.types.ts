export type AppleMailboxRegistrationStatus = 'unknown' | 'unregistered' | 'registered';
export type AppleMailboxTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface AppleMailboxRecord {
  email: string;
  aliasId: string | null;
  registrationStatus: AppleMailboxRegistrationStatus;
  revision: number;
  registrationIp: string | null;
  registrationIpSource: 'manual' | 'observed' | null;
  source: 'manual' | 'automatic' | null;
  markedAt: string | null;
  operatorId: string | null;
  note: string;
  activeTaskUuid: string | null;
  attemptIp: string | null;
  attemptCountry: string | null;
  registrationCountry: string | null;
  lastTaskUuid: string | null;
  lastResultKind: 'new_registration' | 'existing_account' | 'failed' | null;
  taskStatus: AppleMailboxTaskStatus | null;
}

export interface AppleMailboxTask {
  taskUuid: string;
  status: AppleMailboxTaskStatus;
  logs: string[];
  record: AppleMailboxRecord;
  resultKind: AppleMailboxRecord['lastResultKind'];
}

export interface AppleMailboxSummary {
  id: string;
  email: string;
  primaryEmail: string | null;
  status: string;
  note: string | null;
  updatedAt: string;
  authorizationValid: boolean;
  primaryAvailable: boolean;
}

export interface AppleMailboxRow {
  aliasId: string;
  email: string;
  primaryEmail: string | null;
  mailboxStatus: string;
  authorizationValid: boolean;
  primaryAvailable: boolean;
  registrationStatus: AppleMailboxRegistrationStatus;
  registrationIp: string | null;
  registrationIpSource: AppleMailboxRecord['registrationIpSource'];
  source: AppleMailboxRecord['source'];
  note: string | null;
  updatedAt: string;
  revision: number;
  taskUuid: string | null;
  taskStatus: AppleMailboxTaskStatus | null;
  canRegister: boolean;
  blockedReason: string | null;
}

export interface AppleMailboxCodeRequest {
  id: string;
  taskUuid: string;
  aliasId: string;
  email: string;
  since: string;
  previousId: string | null;
}
