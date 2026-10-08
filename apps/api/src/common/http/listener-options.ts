import { isIP } from 'node:net';

/** 显式原生监听地址；无参数保留现有容器监听行为。 */
export function apiListenerHost(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return undefined;
  const host =
    argv.length === 1 && argv[0]?.startsWith('--host=')
      ? argv[0].slice('--host='.length)
      : argv.length === 2 && argv[0] === '--host'
        ? argv[1]
        : undefined;
  if (!host || isIP(host) !== 4) {
    throw new Error('API 监听参数无效，须明确指定 IPv4 地址');
  }
  return host;
}
