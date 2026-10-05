function changed() {
  const error = new Error('SOURCE_CHAIN_CHANGED');
  error.runnerCode = error.message;
  throw error;
}

function fixed(value, scale) {
  const text =
    value !== null && typeof value === 'object' && typeof value.toFixed === 'function'
      ? value.toFixed(scale)
      : String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) changed();
  const negative = text.startsWith('-');
  const [integer, fraction = ''] = text.replace(/^-/, '').split('.');
  if (fraction.length > scale) changed();
  const digits = BigInt(`${integer}${fraction.padEnd(scale, '0')}`);
  const normalized = digits.toString().padStart(scale + 1, '0');
  return `${negative && digits !== 0n ? '-' : ''}${normalized.slice(0, -scale)}.${normalized.slice(-scale)}`;
}

const dateValue = (value) => (value instanceof Date ? value.toISOString() : value);

export function assertHistoricalCashChainUnchanged(account, currentRows, snapshot) {
  const previous = snapshot.audit.accounts.find((row) => row.id === account.id);
  if (
    !previous ||
    account.currency !== previous.currency ||
    account.status !== previous.status ||
    dateValue(account.updatedAt) !== previous.updatedAt ||
    fixed(account.currentBalance, 4) !== fixed(previous.currentBalance, 4) ||
    fixed(account.currentBalanceCny, 4) !== fixed(previous.currentBalanceCny, 4)
  )
    changed();
  const previousRows = snapshot.audit.lines
    .filter((row) => row.accountCode === 'cash' && row.financeAccountId === account.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  const current = [...currentRows].sort((a, b) => a.id.localeCompare(b.id));
  if (previousRows.length !== current.length) changed();
  for (let index = 0; index < previousRows.length; index += 1) {
    const before = previousRows[index];
    const after = current[index];
    for (const [key, expected] of Object.entries(before)) {
      const value = ['amountOriginal', 'amountCny'].includes(key)
        ? fixed(after[key], 4)
        : key === 'fxRateToCny'
          ? fixed(after[key], 8)
          : dateValue(key === 'fxSnapshotId' ? after.fxRateSnapshotId : after[key]);
      if (value !== expected) changed();
    }
    const oldJournal = snapshot.audit.journals.find((row) => row.id === before.journalId);
    if (!oldJournal || !after.journal) changed();
    for (const [key, expected] of Object.entries(oldJournal)) {
      if (key !== 'cashCostEvidenceVersion' && dateValue(after.journal[key]) !== expected)
        changed();
    }
  }
}
