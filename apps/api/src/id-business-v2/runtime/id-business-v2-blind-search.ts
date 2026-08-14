export type IdBusinessV2BlindSearchNamespace =
  | 'apple-id'
  | 'account-phone'
  | 'customer-phone'
  | 'customer-wechat'
  | 'customer-qq'
  | 'customer-whatsapp'
  | 'website-account'
  | 'gift-card-code';

type HashValue = (value: string) => string | null;

const MIN_GRAM_SIZE = 2;
const MAX_GRAM_SIZE = 3;
const TOKEN_VERSION = 'v1';

export function normalizeIdBusinessV2BlindSearchText(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

export function buildIdBusinessV2BlindIndexTokens(
  value: string | null | undefined,
  namespace: IdBusinessV2BlindSearchNamespace,
  hash: HashValue
) {
  const normalized = value ? normalizeIdBusinessV2BlindSearchText(value) : '';
  const characters = Array.from(normalized);
  if (characters.length === 0) return [];
  if (characters.length < MIN_GRAM_SIZE) {
    const token = hash(`${TOKEN_VERSION}:${namespace}:value:${normalized}`);
    return token ? [token] : [];
  }

  const tokens = new Set<string>();
  for (let size = MIN_GRAM_SIZE; size <= MAX_GRAM_SIZE; size += 1) {
    if (characters.length < size) continue;
    for (let index = 0; index <= characters.length - size; index += 1) {
      const token = hash(
        `${TOKEN_VERSION}:${namespace}:${size}:${characters.slice(index, index + size).join('')}`
      );
      if (token) tokens.add(token);
    }
  }
  return [...tokens].sort();
}

export function buildIdBusinessV2BlindQueryTokens(
  value: string | null | undefined,
  namespace: IdBusinessV2BlindSearchNamespace,
  hash: HashValue
) {
  const normalized = value ? normalizeIdBusinessV2BlindSearchText(value) : '';
  const characters = Array.from(normalized);
  if (characters.length < MIN_GRAM_SIZE) return [];

  const size = characters.length >= MAX_GRAM_SIZE ? MAX_GRAM_SIZE : MIN_GRAM_SIZE;
  const tokens = new Set<string>();
  for (let index = 0; index <= characters.length - size; index += 1) {
    const token = hash(
      `${TOKEN_VERSION}:${namespace}:${size}:${characters.slice(index, index + size).join('')}`
    );
    if (token) tokens.add(token);
  }
  return [...tokens].sort();
}

export function matchesIdBusinessV2BlindSearch(value: string, keyword: string) {
  return normalizeIdBusinessV2BlindSearchText(value).includes(
    normalizeIdBusinessV2BlindSearchText(keyword)
  );
}
