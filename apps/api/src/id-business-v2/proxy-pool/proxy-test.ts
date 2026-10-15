import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

export function proxyConnectionVersion(proxy: {
  urlHash: string;
  protocol: string;
  connectionMode: string;
}) {
  return createHash('sha256')
    .update(JSON.stringify([proxy.urlHash, proxy.protocol, proxy.connectionMode]))
    .digest('hex');
}

const privateV4Networks = new BlockList();
const privateV6Networks = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const)
  privateV4Networks.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const)
  privateV6Networks.addSubnet(address, prefix, 'ipv6');

export function publicProxyExitIp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ip = value.trim();
  const family = isIP(ip);
  if (
    !family ||
    ip.includes('%') ||
    (family === 4 ? privateV4Networks.check(ip, 'ipv4') : privateV6Networks.check(ip, 'ipv6'))
  )
    return null;
  // IPv6 global unicast addresses currently use 2000::/3.
  if (family === 6 && !/^[23][0-9a-f]{0,3}:/i.test(ip)) return null;
  return ip;
}

const failureMessages: Record<string, string> = {
  invalid_exit_ip: '检测失败：未取得有效公网出口 IP',
  proxy_auth_failed: '检测失败：代理认证失败，请检查账号和密码',
  connection_timeout: '检测失败：代理连接超时',
  connection_refused: '检测失败：代理连接被拒绝',
  extraction_failed: '检测失败：代理提取失败，请检查提取链接',
  network_error: '检测失败：代理网络连接异常',
  unsupported_protocol: '检测失败：代理协议不受支持',
  proxy_changed: '检测已失效：代理连接资料已修改，请重新检测',
  proxy_unavailable: '检测失败：代理已停用或不存在',
  probe_http_error: '检测失败：出口检测服务返回异常',
  proxy_dns_failed: '检测失败：代理域名解析失败',
  proxy_tls_failed: '检测失败：代理安全连接失败',
  execution_failed: '检测失败：执行过程异常，请重试',
  result_write_failed: '检测结果回写未能确认，请刷新核对后重试',
  completion_ack_failed: '检测结束回执未能确认，请刷新核对任务状态',
  legacy_test: '旧检测缺少连接版本，已停止，请重新检测'
};

export function proxyTestFailureMessage(code: unknown): string {
  return typeof code === 'string' && Object.hasOwn(failureMessages, code)
    ? failureMessages[code]!
    : '检测失败，请检查代理配置后重试';
}

export function safeProxyTestResult(value: unknown): {
  ok: boolean;
  ip: string | null;
  latencyMs: number | null;
  errorCode?: string;
  message: string;
} {
  const input =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const ip = publicProxyExitIp(input.ip);
  const ok = input.ok === true && Boolean(ip);
  const errorCode = ok
    ? undefined
    : input.ok === true
      ? 'invalid_exit_ip'
      : typeof input.errorCode === 'string' && Object.hasOwn(failureMessages, input.errorCode)
        ? input.errorCode
        : 'network_error';
  return {
    ok,
    ip: ok ? ip : null,
    latencyMs:
      typeof input.latencyMs === 'number' && Number.isFinite(input.latencyMs)
        ? Math.min(2_147_483_647, Math.max(0, Math.round(input.latencyMs)))
        : null,
    ...(errorCode
      ? { errorCode, message: proxyTestFailureMessage(errorCode) }
      : { message: '检测成功' })
  };
}

export function safeProxyTestTaskResult(value: unknown, proxyId: unknown) {
  const input =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const results = Array.isArray(input.results) ? input.results : [];
  const result = results.find((row) => row && typeof row === 'object' && row.proxyId === proxyId);
  if (['result_write_failed', 'completion_ack_failed'].includes(String(input.errorCode))) {
    const evidence = safeProxyTestResult(result ?? { ...input, ok: input.probeOk === true });
    return {
      ...evidence,
      ok: false,
      probeOk: evidence.ok,
      errorCode: String(input.errorCode),
      message: proxyTestFailureMessage(input.errorCode)
    };
  }
  return safeProxyTestResult(result ?? input);
}
