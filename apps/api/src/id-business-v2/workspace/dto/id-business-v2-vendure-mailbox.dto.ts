export interface ListIdBusinessV2VendureMailboxDto {
  page?: unknown;
  pageSize?: unknown;
  q?: unknown;
  status?: unknown;
  primaryAccountId?: unknown;
  virtualEmailId?: unknown;
  unassignedOnly?: unknown;
}

export interface CreateIdBusinessV2VendureMailboxPrimaryDto {
  email?: unknown;
  appPassword?: unknown;
  note?: unknown;
  imapHost?: unknown;
  imapPort?: unknown;
  codeResetIntervalDays?: unknown;
  masterQueryCode?: unknown;
}

export interface UpdateIdBusinessV2VendureMailboxPrimaryDto extends Partial<CreateIdBusinessV2VendureMailboxPrimaryDto> {
  status?: unknown;
}

export interface CreateIdBusinessV2VendureMailboxAliasDto {
  primaryAccountId?: unknown;
  aliasEmail?: unknown;
  note?: unknown;
  buyerQueryCode?: unknown;
  codeResetIntervalDays?: unknown;
}

export interface BatchCreateIdBusinessV2VendureMailboxAliasesDto {
  primaryAccountId?: unknown;
  rawInput?: unknown;
  codeResetIntervalDays?: unknown;
}

export interface UpdateIdBusinessV2VendureMailboxAliasDto {
  aliasEmail?: unknown;
  note?: unknown;
  status?: unknown;
  buyerQueryCode?: unknown;
  codeResetIntervalDays?: unknown;
}

export interface ReassignIdBusinessV2VendureMailboxMailDto {
  virtualEmailId?: unknown;
}

export interface ReconcileIdBusinessV2VendureMailboxHistoryDto {
  dryRun?: unknown;
}

export interface QueryIdBusinessV2VendureMailboxDto {
  queryCode?: unknown;
}
