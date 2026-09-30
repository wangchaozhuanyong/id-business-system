export interface BankCardImportRow {
  number: string;
  expiry: string;
  remark1: string;
  remark2: string;
}

// 安全码不属于可导入数据；只接收卡号、有效期和两项备注。
export function parseBankCardImport(text: string): BankCardImportRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 1 || lines.length > 100) throw new Error('请粘贴 1 至 100 行银行卡资料');
  return lines.map((line, index) => {
    const parts = line.includes('\t')
      ? line.split('\t').map((part) => part.trim())
      : line.split(/\s+/);
    if (parts.length < 2 || parts.length > 4 || !parts[0] || !parts[1]) {
      throw new Error(
        `第 ${index + 1} 行格式无效：每行填写卡号、有效期、备注1、备注2；安全码不能导入`
      );
    }
    const [number = '', expiry = '', remark1 = '', remark2 = ''] = parts;
    if (/^\d{3,4}$/.test(remark1) || /^\d{3,4}$/.test(remark2)) {
      throw new Error(`第 ${index + 1} 行可能包含安全码；安全码不能导入或保存`);
    }
    return {
      number,
      expiry,
      remark1: remark1 === '-' ? '' : remark1,
      remark2: remark2 === '-' ? '' : remark2
    };
  });
}
