import { BadRequestException } from '@nestjs/common';
import { text } from './validation';

export function parseOnlineRechargeProxy(value: unknown) {
  let raw = text(value, '代理', 2048);
  if (!raw.includes('://')) {
    const parts = /^([^:/\s]+):(\d{1,5}):([^:\r\n]+):([^\r\n]+)$/.exec(raw);
    if (!parts || Number(parts[2]) < 1 || Number(parts[2]) > 65535)
      throw new BadRequestException('代理格式无效，请使用协议地址或主机:端口:用户名:密码');
    raw = `http://${encodeURIComponent(parts[3])}:${encodeURIComponent(parts[4])}@${parts[1]}:${parts[2]}`;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('代理格式无效');
  }
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname)
    throw new BadRequestException('代理需要有效协议和主机');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'api.ipdeep.com' ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== '/api/Pro/DynamicIp/GetIpByGenerateLink' ||
      !url.searchParams.get('id')
    )
      throw new BadRequestException(
        '动态提取仅支持有效的 IPDEEP 生成链接；直连代理不能带路径或查询参数'
      );
    return { raw, displayHost: 'api.ipdeep.com（每任务提取）', protocol: 'extraction' };
  }
  // 原代码在每次执行前替换字面量 {session}；URL.href 会编码它，必须保存原始规范输入。
  return {
    raw,
    displayHost: `${url.hostname}${url.port ? `:${url.port}` : ''}`,
    protocol: url.protocol.slice(0, -1)
  };
}
