export type IdBusinessV2AccountSecretField = 'appleId' | 'password' | 'phone' | 'securityInfo';

export interface RevealIdBusinessV2AccountSecretDto {
  field?: IdBusinessV2AccountSecretField | string | null;
  reason?: string | null;
  approvalId?: string | null;
}
