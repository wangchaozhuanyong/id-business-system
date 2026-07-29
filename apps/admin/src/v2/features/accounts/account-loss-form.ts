export function isAccountLossConfirmationValid(reason: string, confirmed: boolean) {
  const normalizedLength = reason.trim().length;
  return confirmed && normalizedLength >= 2 && normalizedLength <= 500;
}
