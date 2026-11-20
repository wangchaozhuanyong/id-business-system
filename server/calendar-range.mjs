const dayMs = 86_400_000;

function isoMidnight(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
}

export function calendarRange(from, to, utcOffset = 8) {
  const first = isoMidnight(from), last = isoMidnight(to);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) return undefined;
  const offset = utcOffset * 3_600_000;
  return { from, to, start: first - offset, end: last - offset + dayMs, days: (last - first) / dayMs + 1 };
}

export function calendarDates(from, days) {
  const first = isoMidnight(from);
  return Array.from({ length: days }, (_, index) => new Date(first + index * dayMs).toISOString().slice(0, 10));
}

export function calendarDate(at, timeZone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('sv-SE', { timeZone }).format(at);
}
