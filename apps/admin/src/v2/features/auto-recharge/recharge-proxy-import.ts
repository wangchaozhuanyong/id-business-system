import { parseProxyCountry, parseProxyKind, type ProxyKind } from './recharge-proxy-options';

export interface RechargeProxyImportRow {
  countryCode: string;
  url: string;
  kind: ProxyKind;
  remark1: string;
  remark2: string;
}

export function parseRechargeProxyImport(text: string): RechargeProxyImportRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length || lines.length > 100) throw new Error('请粘贴 1 至 100 行代理 IP 资料');
  return lines.map((line, index) => {
    const parts = line.includes('\t')
      ? line.split('\t').map((part) => part.trim())
      : line.split(/\s+/);
    if (parts.length < 3 || parts.length > 5 || !parts[0] || !parts[1] || !parts[2]) {
      throw new Error(`第 ${index + 1} 行格式无效：国家、IP 链接、属性、备注1、备注2`);
    }
    try {
      return {
        countryCode: parseProxyCountry(parts[0]),
        url: parts[1],
        kind: parseProxyKind(parts[2]),
        remark1: parts[3] === '-' ? '' : (parts[3] ?? ''),
        remark2: parts[4] === '-' ? '' : (parts[4] ?? '')
      };
    } catch (error) {
      throw new Error(
        `第 ${index + 1} 行：${error instanceof Error ? error.message : '资料无效'}`,
        { cause: error }
      );
    }
  });
}
