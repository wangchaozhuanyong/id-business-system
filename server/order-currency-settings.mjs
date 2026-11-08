export function validOrderCurrencies(rows) {
  return Array.isArray(rows) && rows.length > 0 && rows.length <= 100 &&
    new Set(rows.map(row => row?.code)).size === rows.length &&
    rows.every(row => row && Object.keys(row).every(key => ['code', 'name'].includes(key)) &&
      typeof row.code === 'string' && /^[A-Z]{3}$/.test(row.code) &&
      typeof row.name === 'string' && row.name.trim() === row.name && row.name.length > 0 &&
      row.name.length <= 40 && !/[\r\n\t]/.test(row.name));
}

export function validOrderCurrencyGroups(groups) {
  return groups && typeof groups === 'object' && !Array.isArray(groups) &&
    Object.entries(groups).every(([key, rows]) => ['GPT', 'Claude'].includes(key) && validOrderCurrencies(rows));
}

// Settings are shared with other modules; partial writes must retain both product families.
export function retainOrderCurrencySettings(data, previous) {
  const next = { ...data };
  if (!Object.hasOwn(next, 'orderCurrencies') && previous?.orderCurrencies)
    next.orderCurrencies = previous.orderCurrencies;
  if (Object.hasOwn(next, 'orderCurrenciesByProduct') || previous?.orderCurrenciesByProduct)
    next.orderCurrenciesByProduct = { ...previous?.orderCurrenciesByProduct, ...next.orderCurrenciesByProduct };
  return next;
}
