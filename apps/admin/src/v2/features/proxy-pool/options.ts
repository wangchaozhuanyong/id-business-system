import type { FormRules } from 'element-plus';

export function createProxyFormRules(link?: {
  field: 'url' | 'text';
  mode: () => 'direct' | 'extraction';
  protocol: () => ProxyProtocol;
  optional?: () => boolean;
}): FormRules {
  const rules: FormRules = {
    countryCode: [
      { required: true, message: '请选择国家', trigger: 'change' },
      {
        trigger: ['blur', 'change'],
        validator: (_rule, value: unknown, callback) => {
          try {
            if (value) parseProxyCountry(String(value));
            callback();
          } catch {
            callback(new Error('请选择国家或填写两位国家代码'));
          }
        }
      }
    ],
    url: [{ required: false, trigger: 'blur' }],
    kind: [{ required: true, message: '请选择 IP 属性', trigger: 'change' }],
    connectionMode: [{ required: true, message: '请选择连接方式', trigger: 'change' }],
    protocol: [{ required: true, message: '请选择代理协议', trigger: 'change' }]
  };
  if (link)
    rules[link.field] = [
      {
        trigger: ['blur', 'change'],
        validator: (_rule, value: unknown, callback) => {
          try {
            if (link.optional?.() && !value) return callback();
            if (link.field === 'text')
              normalizeProxyImport(String(value ?? ''), link.mode(), link.protocol());
            else normalizeProxyLink(String(value ?? ''), link.mode(), link.protocol());
            callback();
          } catch (cause) {
            callback(new Error((cause as Error).message));
          }
        }
      }
    ];
  return rules;
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
    : '待补充';
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

const proxyRegionNames = new Intl.DisplayNames(['zh-Hans'], { type: 'region', fallback: 'none' });

export function proxyCountryLabel(code: string) {
  if (!/^[A-Z]{2}$/.test(code)) return '待补充';
  return (
    proxyCountries.find(([value]) => value === code)?.[1] ?? proxyRegionNames.of(code) ?? '未知国家'
  );
}

export const proxyCountryCurrencies: Readonly<Record<string, string>> = {
  PH: 'PHP',
  US: 'USD',
  ID: 'IDR',
  CL: 'CLP',
  MY: 'MYR',
  GB: 'GBP',
  AU: 'AUD',
  CA: 'CAD',
  JP: 'JPY',
  KR: 'KRW',
  SG: 'SGD',
  IN: 'INR',
  TH: 'THB',
  VN: 'VND',
  TW: 'TWD',
  HK: 'HKD',
  BR: 'BRL',
  MX: 'MXN',
  AE: 'AED',
  SA: 'SAR',
  ZA: 'ZAR',
  NZ: 'NZD',
  CH: 'CHF',
  SE: 'SEK',
  NO: 'NOK',
  DK: 'DKK',
  PL: 'PLN',
  TR: 'TRY',
  CN: 'CNY',
  DE: 'EUR',
  FR: 'EUR',
  IT: 'EUR',
  ES: 'EUR',
  NL: 'EUR',
  BE: 'EUR',
  AT: 'EUR',
  IE: 'EUR',
  PT: 'EUR',
  FI: 'EUR',
  GR: 'EUR'
};

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

function encodeProxyCredential(value: string) {
  // 会话占位符必须保留为字面量，由执行器在每次连接时替换。
  return encodeURIComponent(value).replace(/%7Bsession%7D/gi, '{session}');
}

function hasProxyControlCharacters(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

/** 标准链接保留自身协议；供应商文本使用所选协议，凭据按原文编码。 */
export function normalizeProxyLink(
  raw: string,
  mode: 'direct' | 'extraction',
  selected: ProxyProtocol
): { url: string; protocol: ProxyProtocol } {
  let url = raw.trim();
  if (!url) throw new Error(mode === 'direct' ? '请填写代理地址' : '请填写 HTTPS 提取链接');
  if (hasProxyControlCharacters(url)) throw new Error('代理链接不能包含换行或控制字符');
  let protocol = selected;
  if (mode === 'direct') {
    const explicit = /^(http|https|socks5):\/\//i.exec(url)?.[1]?.toLowerCase();
    if (explicit) protocol = explicit as ProxyProtocol;
    else {
      if (url.includes('://')) throw new Error('代理协议仅支持 HTTP、HTTPS 或 SOCKS5');
      const supplier = /^(\[[^\]]+\]|[^:\s/@?#]+):(\d+)(?::([^:]+):(.+))?$/.exec(url);
      if (!supplier) throw new Error('请填写“主机:端口:账号:密码”或“协议://账号:密码@主机:端口”');
      const [, host, port, username, password] = supplier;
      if (Number(port) < 1 || Number(port) > 65535) throw new Error('代理端口须为 1 至 65535');
      url = `${selected}://${username ? `${encodeProxyCredential(username)}:${encodeProxyCredential(password!)}@` : ''}${host}:${port}`;
    }
  }
  if (url.length > 2000) throw new Error('代理链接编码后不能超过 2000 个字符');
  try {
    const parsed = new URL(url);
    if (!parsed.hostname || parsed.hash || /\s/.test(url)) throw new Error();
    if (mode === 'extraction') {
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
    } else {
      const port = /^[-a-z0-9+.]+:\/\/(?:[^@/]*@)?(?:\[[^\]]+\]|[^:/?#]+):(\d+)(?:[/?#]|$)/i.exec(
        url
      )?.[1];
      if (
        parsed.protocol !== `${protocol}:` ||
        (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) ||
        !['', '/'].includes(parsed.pathname) ||
        parsed.search ||
        Boolean(parsed.username) !== Boolean(parsed.password) ||
        (protocol === 'socks5' && !parsed.port)
      )
        throw new Error();
      const credentials = decodeURIComponent(parsed.username) + decodeURIComponent(parsed.password);
      if (hasProxyControlCharacters(credentials)) throw new Error();
    }
  } catch {
    throw new Error(
      mode === 'extraction'
        ? '提取链接须为有效的 HTTPS 地址，不能包含账号、密码或片段'
        : '代理地址格式无效，请检查主机、端口和凭据；链接中的特殊字符需要编码'
    );
  }
  return { url, protocol };
}

export function normalizeProxyImport(
  text: string,
  mode: 'direct' | 'extraction',
  selected: ProxyProtocol
) {
  const rows = text
    .split(/\r?\n/)
    .flatMap((url, index) => (url.trim() ? [{ url, line: index + 1 }] : []));
  if (!rows.length || rows.length > 500) throw new Error('每次需要导入 1 至 500 条代理');
  return rows.map(({ url, line }) => {
    try {
      return normalizeProxyLink(url, mode, selected);
    } catch (cause) {
      throw new Error(`第 ${line} 行：${(cause as Error).message}`, { cause });
    }
  });
}

/** 兼容已有调用；实际保存必须使用 normalizeProxyLink 返回的地址。 */
export function protocolForProxyLink(
  url: string,
  mode: 'direct' | 'extraction',
  selected: ProxyProtocol
): ProxyProtocol {
  if (mode === 'extraction' || !url.trim()) return selected;
  return normalizeProxyLink(url, mode, selected).protocol;
}
