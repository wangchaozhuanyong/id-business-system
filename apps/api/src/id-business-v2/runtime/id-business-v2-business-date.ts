export function toKualaLumpurBusinessDate(value: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const text = `${get('year')}-${get('month')}-${get('day')}`;
  return {
    text,
    month: text.slice(0, 7),
    date: new Date(`${text}T00:00:00.000Z`)
  };
}
