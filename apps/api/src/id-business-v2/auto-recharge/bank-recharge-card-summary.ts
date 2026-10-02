import type { FieldEncryptionService } from '../../common/crypto/field-encryption.service';

/** 只保留首位及末八位；缺少完整卡号时不能从尾四位推断。 */
export function bankRechargeCardNumberSummary(number: string | null | undefined) {
  const digits = number?.replace(/[ -]/g, '');
  if (!digits || !/^\d{12,19}$/.test(digits)) return null;
  return `${digits[0]}${'*'.repeat(digits.length - 9)}${digits.slice(-8)}`;
}

export function encryptedBankRechargeCardSummary(
  encryption: FieldEncryptionService,
  numberEncrypted: string | null | undefined
) {
  const summary = bankRechargeCardNumberSummary(encryption.decrypt(numberEncrypted));
  return summary ? encryption.encrypt(summary) : null;
}

export function readBankRechargeCardSummary(
  encryption: FieldEncryptionService,
  summaryEncrypted: string | null | undefined,
  numberEncrypted: string | null | undefined
) {
  const snapshot = encryption.decrypt(summaryEncrypted);
  return snapshot && /^\d\*{3,10}\d{8}$/.test(snapshot)
    ? snapshot
    : bankRechargeCardNumberSummary(encryption.decrypt(numberEncrypted));
}

export function bankRechargeCardSnapshot(
  encryption: FieldEncryptionService,
  card: { label: string; numberEncrypted: string | null } | null
) {
  return {
    cardLabelSnapshot: card?.label ?? null,
    cardNumberSummaryEncrypted: encryptedBankRechargeCardSummary(encryption, card?.numberEncrypted),
    cardDeletedAt: null
  };
}
