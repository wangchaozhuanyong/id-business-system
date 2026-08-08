export interface CreateIdBusinessV2SensitiveAccessRequestDto {
  module?: string;
  fieldName?: string;
  objectType?: string;
  objectId?: string;
  reason?: string;
}

export interface DecideIdBusinessV2SensitiveAccessRequestDto {
  decision?: 'approved' | 'rejected' | string;
  decisionNote?: string | null;
}

export interface ListIdBusinessV2SensitiveAccessRequestsQuery {
  module?: string;
  fieldName?: string;
  objectType?: string;
  objectId?: string;
  status?: string;
  page?: string;
  pageSize?: string;
}
