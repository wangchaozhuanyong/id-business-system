export function getListCacheKey(namespace: string, query: object) {
  const params = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([left], [right]) => left.localeCompare(right));

  return `${namespace}:${JSON.stringify(params)}`;
}
