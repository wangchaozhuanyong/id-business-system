const COUNTRY_CURRENCY_BY_NAME = new Map<string, string>([
  ['菲律宾', 'PHP'],
  ['菲律賓', 'PHP'],
  ['philippines', 'PHP'],
  ['the philippines', 'PHP'],
  ['republic of the philippines', 'PHP']
]);

function normalizeCountryName(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function matchCountryCurrencyCode(countryName: string) {
  return COUNTRY_CURRENCY_BY_NAME.get(normalizeCountryName(countryName)) ?? null;
}

export function resolveCountryCurrencyAutoMatch(
  countryName: string,
  currentCurrencyCode: string,
  previousAutoMatchedCurrencyCode: string
) {
  const matchedCurrencyCode = matchCountryCurrencyCode(countryName) ?? '';
  const normalizedCurrentCurrencyCode = currentCurrencyCode.trim().toUpperCase();
  const normalizedPreviousCurrencyCode = previousAutoMatchedCurrencyCode.trim().toUpperCase();

  if (
    normalizedCurrentCurrencyCode &&
    normalizedCurrentCurrencyCode !== normalizedPreviousCurrencyCode
  ) {
    return {
      currencyCode: currentCurrencyCode,
      autoMatchedCurrencyCode: ''
    };
  }

  return {
    currencyCode: matchedCurrencyCode,
    autoMatchedCurrencyCode: matchedCurrencyCode
  };
}
