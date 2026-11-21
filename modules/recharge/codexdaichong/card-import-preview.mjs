// Preview reports only row numbers. The locked card pool still validates the submitted batch.
export function inspectCardImport(text, knownNumbers = [], role = 'finance') {
  const seen = new Set(knownNumbers);
  return text.split(/\r?\n/).flatMap((source, index) => {
    const line = source.trim();
    if (!line) return [];
    let card, invalid;
    if (role === 'finance') {
      const match = /^(\d{12,19})\s*(?:\|\s*|\s+)(0[1-9]|1[0-2])\/(\d{2}|\d{4})\s*(?:\|\s*|\s+)(\d{3,4})(?:(?:\s*\|\s*|\s+)([^\u0000-\u001f]{1,100}))?$/.exec(line);
      if (match) card = { card_number: match[1], card_expiry: match[2] + '/' + match[3].slice(-2),
        card_cvc: match[4], card_holder: match[5]?.trim() || '' };
      invalid = !card;
    } else {
      const parts = (line.includes('|') ? line :
        line.replace(/^(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/, '$1|$2|$3|$4')).split('|').map(value => value.trim());
      if (parts.length >= 3) card = { card_number: parts[0], card_expiry: parts[1], card_cvc: parts[2], card_holder: parts[3] || '' };
      invalid = !card || !/^\d{13,19}$/.test(card.card_number.replace(/[\s-]+/g, '')) ||
        !/^(0[1-9]|1[0-2])\/?\d{2}$/.test(card.card_expiry) || !/^\d{3,4}$/.test(card.card_cvc);
    }
    let state = 'invalid';
    if (!invalid) {
      const number = card.card_number.replace(/[\s-]+/g, '');
      state = seen.has(number) ? 'duplicate' : 'valid';
      seen.add(number);
    }
    return [{ line: index + 1, source, card, state }];
  });
}

export function describeCardImport(rows) {
  const labels = [['valid', '待导入'], ['duplicate', '已知重复'], ['invalid', '格式有误']];
  return labels.map(([state, label]) => {
    const lines = rows.filter(row => row.state === state).map(row => row.line);
    return lines.length ? label + ' ' + lines.length + ' 行（第 ' + lines.join('、') + ' 行）' : label + ' 0 行';
  }).join(' · ');
}

export function cardImportFailureIndexes(receipt, length) {
  const counts = [receipt?.imported, receipt?.skipped, receipt?.failed];
  if (receipt?.success !== true || counts.some(count => !Number.isSafeInteger(count) || count < 0 || count > length) ||
      counts.reduce((sum, count) => sum + count, 0) !== length ||
      !Array.isArray(receipt.failures) || receipt.failures.length !== receipt.failed)
    throw new Error('卡池导入结果待核对，请先刷新列表');
  const indexes = new Set(receipt.failures.map(item => item?.index));
  if (indexes.size !== receipt.failed || [...indexes].some(index => !Number.isSafeInteger(index) || index < 0 || index >= length))
    throw new Error('卡池导入结果待核对，请先刷新列表');
  return indexes;
}
