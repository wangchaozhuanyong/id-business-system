export function formatAccountDecimal(value: string) {
  const number = Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString('zh-CN', { maximumFractionDigits: 4 })
    : value;
}

export function formatAccountDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}
