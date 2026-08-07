export function isUnsupportedFinanceCurrencyEnumError(error: unknown, currency?: string) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (
    !message.includes('invalid input value for enum') ||
    !message.includes('IdBusinessV2FinanceCurrency')
  ) {
    return false;
  }
  return currency ? message.includes(currency) : true;
}
