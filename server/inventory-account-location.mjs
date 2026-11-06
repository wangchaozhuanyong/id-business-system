const defaultLocations = new Map([
  ['马来西亚', ['吉隆坡', '槟城', '新山']],
  ['美国', ['纽约', '洛杉矶', '芝加哥']],
  ['日本', ['东京', '大阪']],
  ['新加坡', ['新加坡']]
]);

const accountTypes = new Map([['gpt', 'GPT'], ['claude', 'Claude']]);

function labels(values) {
  return Array.isArray(values) &&
    values.every((value) => typeof value === 'string' && value.length > 0 && value === value.trim()) &&
    new Set(values).size === values.length;
}

export function checkAccountLocations(previous, next) {
  const settings = new Map();
  for (const entry of next?.tableSettings ?? []) {
    if (!Array.isArray(entry) || !accountTypes.has(entry[0])) continue;
    const [type, config] = entry;
    if (settings.has(type) || !config || !labels(config.countries) || !config.countries.length)
      return `${accountTypes.get(type)} 账号的国家地区设置格式不正确`;
    const cities = config.cities ?? [];
    if (!Array.isArray(cities) ||
        !cities.every((pair) => Array.isArray(pair) && pair.length === 2 &&
          config.countries.includes(pair[0]) && labels(pair[1])) ||
        new Set(cities.map(([country]) => country)).size !== cities.length)
      return `${accountTypes.get(type)} 账号的地区／城市设置格式不正确`;
    settings.set(type, { countries: config.countries, cities: new Map(cities) });
  }

  const priorById = new Map(
    (previous?.accounts ?? []).filter((row) => row?.id).map((row) => [row.id, row])
  );
  for (const row of next?.accounts ?? []) {
    const product = accountTypes.get(row?.type);
    if (!product) continue;
    const prior = priorById.get(row.id);
    if (prior?.type === row.type && prior.email === row.email &&
        (prior.country ?? '') === (row.country ?? '') &&
        (prior.city ?? '') === (row.city ?? '')) continue;

    const config = settings.get(row.type);
    if (!row.country || !(config?.countries ?? [...defaultLocations.keys()]).includes(row.country))
      return `请选择 ${product} 账号国家地区设置中的注册国家`;
    const cities = config?.cities.get(row.country) ?? defaultLocations.get(row.country) ?? [];
    if (!row.city || !cities.includes(row.city))
      return `请选择 ${product} 账号所选国家下的地区／城市`;
  }
}
