export function isAccountLossRecoveryReasonValid(reason: string) {
  const length = reason.trim().length;
  return length >= 2 && length <= 500;
}
