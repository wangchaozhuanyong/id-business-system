import type { FormRules } from 'element-plus';

export function createProxyFormRules(): FormRules {
  return {
    countryCode: [{ required: true, message: '请选择国家', trigger: 'change' }],
    url: [{ required: false, trigger: 'blur' }],
    kind: [{ required: true, message: '请选择 IP 属性', trigger: 'change' }],
    protocol: [{ required: true, message: '请选择代理协议', trigger: 'change' }]
  };
}

export const proxyKindLabels = {
  dynamic_residential: '动态住宅',
  static_residential: '静态住宅',
  mobile: '移动代理'
} as const;

export type ProxyKind = keyof typeof proxyKindLabels;
export const proxyProtocolLabels = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' } as const;
export type ProxyProtocol = keyof typeof proxyProtocolLabels;
export function proxyProtocolLabel(value: unknown) {
  return typeof value === 'string' && Object.hasOwn(proxyProtocolLabels, value)
    ? proxyProtocolLabels[value as ProxyProtocol]
    : '未知协议';
}

export function proxyKindLabel(value: unknown) {
  return typeof value === 'string' && Object.hasOwn(proxyKindLabels, value)
    ? proxyKindLabels[value as ProxyKind]
    : '未知属性';
}

export const proxyCountries = [
  ['US', '美国'],
  ['PH', '菲律宾'],
  ['ID', '印度尼西亚'],
  ['CL', '智利'],
  ['MY', '马来西亚'],
  ['GB', '英国'],
  ['AU', '澳大利亚'],
  ['CA', '加拿大'],
  ['JP', '日本'],
  ['KR', '韩国'],
  ['SG', '新加坡'],
  ['IN', '印度'],
  ['TH', '泰国'],
  ['VN', '越南'],
  ['TW', '中国台湾'],
  ['HK', '中国香港'],
  ['BR', '巴西'],
  ['MX', '墨西哥'],
  ['AE', '阿联酋'],
  ['SA', '沙特阿拉伯'],
  ['ZA', '南非'],
  ['NZ', '新西兰'],
  ['CH', '瑞士'],
  ['SE', '瑞典'],
  ['NO', '挪威'],
  ['DK', '丹麦'],
  ['PL', '波兰'],
  ['TR', '土耳其'],
  ['DE', '德国'],
  ['FR', '法国'],
  ['IT', '意大利'],
  ['ES', '西班牙'],
  ['NL', '荷兰'],
  ['BE', '比利时'],
  ['AT', '奥地利'],
  ['IE', '爱尔兰'],
  ['PT', '葡萄牙'],
  ['FI', '芬兰'],
  ['GR', '希腊']
] as const;

export function proxyCountryLabel(code: string) {
  return proxyCountries.find(([value]) => value === code)?.[1] ?? code;
}

export function parseProxyCountry(value: string) {
  const input = value.trim();
  const found = proxyCountries.find(
    ([code, label]) => code.toLowerCase() === input.toLowerCase() || label === input
  );
  if (found) return found[0];
  if (/^[A-Za-z]{2}$/.test(input)) return input.toUpperCase();
  throw new Error(`国家“${input}”无效，请填写两位国家代码或列表中的中文名称`);
}

export function parseProxyKind(value: string): ProxyKind {
  const input = value.trim();
  const aliases: Record<string, ProxyKind> = {
    动态住宅: 'dynamic_residential',
    静态住宅: 'static_residential',
    移动代理: 'mobile',
    移动移动代理: 'mobile'
  };
  const kind = aliases[input] ?? (input as ProxyKind);
  if (!Object.hasOwn(proxyKindLabels, kind)) throw new Error(`代理属性“${input}”无效`);
  return kind;
}
