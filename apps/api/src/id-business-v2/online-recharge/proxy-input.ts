import { BadRequestException } from '@nestjs/common';
import { text } from './validation';

export function parseOnlineRechargeProxy(value: unknown) {
  const raw = text(value, '代理', 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('代理格式无效');
  }
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname)
    throw new BadRequestException('代理需要有效协议和主机');
  // 原代码在每次执行前替换字面量 {session}；URL.href 会编码它，必须保存原始规范输入。
  return {
    raw,
    displayHost: `${url.hostname}${url.port ? `:${url.port}` : ''}`,
    protocol: url.protocol.slice(0, -1)
  };
}
