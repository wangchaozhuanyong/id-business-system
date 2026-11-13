const collections = new Map([
  ['commerce', ['customers', 'tenants', 'orders', 'operating', 'rentBatches', 'logs']],
  ['inventory', ['mailboxes', 'accounts', 'batches', 'returnRecords', 'importRecords', 'registrationRecords', 'tableSettings', 'undo']]
]);
const maximumRows = 100;
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const rowKey = row => Array.isArray(row) ? row[0] : row?.id;
const validKey = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

// Use one contiguous change per collection and retain the document version.
// Large, multi-region and non-array changes keep the existing snapshot format.
export function documentDelta(domain, before, after) {
  const writable = collections.get(domain);
  if (!writable || !before || !after) return;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes = [];
  for (const key of keys) {
    const previous = before[key], next = after[key];
    if (!writable.includes(key) || !Array.isArray(previous) || !Array.isArray(next)) {
      if (!same(previous, next)) return;
      continue;
    }
    let start = 0, priorEnd = previous.length, nextEnd = next.length;
    while (start < priorEnd && start < nextEnd && same(previous[start], next[start])) start++;
    while (priorEnd > start && nextEnd > start && same(previous[priorEnd - 1], next[nextEnd - 1])) {
      priorEnd--;
      nextEnd--;
    }
    if (Math.max(priorEnd - start, nextEnd - start) > maximumRows) return;
    if (priorEnd === start && nextEnd === start) continue;
    const previousKeys = previous.slice(start, priorEnd).map(rowKey);
    const nextKeys = next.slice(start, nextEnd).map(rowKey);
    const anchor = priorEnd === previous.length ? null : rowKey(previous[priorEnd]);
    if (previousKeys.concat(nextKeys).some(id => !validKey(id)) || (anchor !== null && !validKey(anchor)))
      return;
    changes.push({ collection: key, start, length: previous.length, previousKeys, anchor, rows: next.slice(start, nextEnd) });
  }
  return changes.length ? changes : undefined;
}

export function validDocumentDelta(domain, delta) {
  const writable = collections.get(domain);
  if (!writable || !Array.isArray(delta) || !delta.length || delta.length > writable.length) return false;
  return new Set(delta.map(change => change?.collection)).size === delta.length && delta.every(change =>
    change && writable.includes(change.collection) &&
    Number.isSafeInteger(change.start) && change.start >= 0 && Number.isSafeInteger(change.length) && change.length >= change.start &&
    Array.isArray(change.previousKeys) && change.previousKeys.length <= maximumRows && change.previousKeys.every(validKey) &&
    (change.anchor === null || validKey(change.anchor)) &&
    Array.isArray(change.rows) && change.rows.length <= maximumRows && change.rows.every(row => validKey(rowKey(row))) &&
    (change.previousKeys.length || change.rows.length));
}

export function applyDocumentDelta(domain, prior, delta) {
  if (!prior || !validDocumentDelta(domain, delta)) return;
  const snapshot = { ...prior };
  for (const { collection, start, length, previousKeys, anchor, rows } of delta) {
    const current = prior[collection];
    const end = start + previousKeys.length;
    if (!Array.isArray(current) || current.length !== length || end > length ||
        (end === length ? anchor !== null : rowKey(current[end]) !== anchor) ||
        previousKeys.some((id, index) => rowKey(current[start + index]) !== id)) return;
    snapshot[collection] = current.toSpliced(start, previousKeys.length, ...rows);
  }
  return snapshot;
}
