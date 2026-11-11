// Business numbers supplement internal IDs; existing return receipts and ownership keep using those IDs.
export function numberedRechargeRequests(requests) {
  let highest = 0;
  const used = new Set();
  for (const row of requests) {
    if (row.batchNo === undefined) continue;
    const value = typeof row.batchNo === 'string' && /^PO\d{6,}$/.test(row.batchNo)
      ? Number(row.batchNo.slice(2)) : NaN;
    if (!Number.isSafeInteger(value) || value < 1 || row.batchNo !== 'PO' + String(value).padStart(6, '0') || used.has(value))
      throw new Error('invalid_recharge_batch_number');
    used.add(value);
    highest = Math.max(highest, value);
  }
  const missing = requests.filter(row => row.batchNo === undefined).sort((a, b) => {
    const timeA = Date.parse(a.createdAt || a.issuedAt) || 0;
    const timeB = Date.parse(b.createdAt || b.issuedAt) || 0;
    return timeA - timeB || String(a.id).localeCompare(String(b.id), 'en');
  });
  const assigned = new Map(missing.map(row => {
    if (!Number.isSafeInteger(++highest)) throw new Error('recharge_batch_number_exhausted');
    return [row.id, 'PO' + String(highest).padStart(6, '0')];
  }));
  return requests.map(row => row.batchNo === undefined ? { ...row, batchNo: assigned.get(row.id) } : row);
}

export const rechargeCodeItemNumber = (row, code) =>
  row.batchNo + '-' + String(row.codes.indexOf(code) + 1).padStart(2, '0');
