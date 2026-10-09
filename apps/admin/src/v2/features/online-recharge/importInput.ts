export function importLines(value: unknown) {
  const lines = String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length || lines.length > 500) throw new Error('每次需要导入 1 至 500 条记录');
  return lines;
}
export function parseImportedCards(value: unknown) {
  return importLines(value).map((line, index) => {
    const parts = line.split(/[|,\t]/).map((part) => part.trim());
    const [number, expiry] = parts;
    const originalFormat = /^\d{1,2}\/\d{2,4}$/.test(expiry ?? '');
    const [month, year] = originalFormat ? expiry.split('/') : [parts[1], parts[2]];
    const cvc = originalFormat ? parts[2] : parts[3];
    const holderName = originalFormat ? parts[3] : parts[4];
    if (
      !/^\d{13,19}$/.test(number ?? '') ||
      !/^\d{3,4}$/.test(cvc ?? '') ||
      !(Number(month) >= 1 && Number(month) <= 12) ||
      !/^\d{2,4}$/.test(year ?? '')
    )
      throw new Error(`第 ${index + 1} 行银行卡格式不正确，请按卡号|月/年|安全码|持卡人填写`);
    return {
      number,
      expiryMonth: Number(month),
      expiryYear: Number(year),
      cvc,
      holderName: holderName ?? ''
    };
  });
}
