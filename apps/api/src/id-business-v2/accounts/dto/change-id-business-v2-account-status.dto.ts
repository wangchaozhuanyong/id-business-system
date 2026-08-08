export interface ChangeIdBusinessV2AccountStatusDto {
  recordStatus: 'active' | 'disabled' | string;
  reason: string;
}
