import { subscriptionTime } from './order-opening.mjs';

const ids = new Intl.Collator('en', { numeric: true });

export function firstRecordTime(...values) {
  for (const value of values) {
    const time = typeof value === 'number' ? value : subscriptionTime(value);
    if (Number.isFinite(time)) return time;
  }
  return null;
}

export function sortByRecordTime(rows, timeOf, direction = 'desc') {
  const sign = direction === 'asc' ? 1 : -1;
  const timed = rows.map(row => {
    const value = timeOf(row);
    return { row, time: Array.isArray(value) ? firstRecordTime(...value) : firstRecordTime(value) };
  });
  timed.sort((left, right) => {
    if (left.time !== right.time) {
      if (left.time === null) return 1;
      if (right.time === null) return -1;
      return sign * (left.time - right.time);
    }
    const a = String(left.row.id ?? ''), b = String(right.row.id ?? '');
    return ids.compare(b, a) || (a === b ? 0 : a < b ? 1 : -1);
  });
  return timed.map(({ row }) => row);
}

export function defaultSubscriptionSort(scope) {
  if (scope === 'upcoming') return 'expiry_asc';
  if (scope === 'expired') return 'expiry_desc';
  return 'recent';
}

export function sortByFundingDeadline(rows, deadlineOf, current) {
  const active = [], other = [];
  for (const row of rows) {
    const group = current(row) && firstRecordTime(deadlineOf(row)) !== null ? active : other;
    group.push(row);
  }
  return sortByRecordTime(active, deadlineOf, 'asc').concat(sortByRecordTime(other, deadlineOf));
}

if (typeof window !== 'undefined') window.IDListOrder = Object.freeze({
  firstRecordTime, sortByRecordTime, defaultSubscriptionSort, sortByFundingDeadline
});
