export function isAccountRecordStatusReasonValid(reason: string) {
  const length = reason.trim().length;
  return length >= 2 && length <= 200;
}
