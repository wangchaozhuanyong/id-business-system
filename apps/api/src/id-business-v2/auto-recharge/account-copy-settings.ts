export const ACCOUNT_COPY_SETTINGS_OWNER_ID = '__chatgpt_account_copy_settings__';

export function accountCopySuffix(options: unknown): string {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return '';
  const value = (options as Record<string, unknown>).accountCopySuffix;
  return typeof value === 'string' ? value : '';
}

export function accountCopyMetadata(options: unknown) {
  const suffix = accountCopySuffix(options);
  return suffix ? { accountCopySuffix: suffix } : {};
}
