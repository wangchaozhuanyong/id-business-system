export interface CreateIdBusinessV2ManagedMailboxDto {
  appPassword?: unknown;
  email?: unknown;
  label?: unknown;
  provider?: unknown;
}

export interface ListIdBusinessV2ManagedMailboxesDto {
  page?: unknown;
  pageSize?: unknown;
  provider?: unknown;
  q?: unknown;
  status?: unknown;
}

export interface UpdateIdBusinessV2ManagedMailboxStatusDto {
  status?: unknown;
}

export interface UpdateIdBusinessV2ManagedMailboxCredentialDto {
  appPassword?: unknown;
}
