export interface ChangeIdBusinessV2AccountStatusDto {
  expectedUpdatedAt?: string;
  recordStatus: 'active' | 'disabled' | string;
  reason: string;
}
