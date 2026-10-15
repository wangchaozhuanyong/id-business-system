import { describe, expect, it } from 'vitest';
import { normalizeProxyImport, normalizeProxyLink } from './options';

describe('代理地址与供应商格式规范化', () => {
  it('使用所选协议转换供应商格式，标准链接保留自身协议', () => {
    expect(
      normalizeProxyLink('gateway.example.test:8080:demo:invalid', 'direct', 'socks5')
    ).toEqual({ url: 'socks5://demo:invalid@gateway.example.test:8080', protocol: 'socks5' });
    expect(
      normalizeProxyLink('https://demo:invalid@gateway.example.test:443', 'direct', 'socks5')
    ).toEqual({ url: 'https://demo:invalid@gateway.example.test:443', protocol: 'https' });
    expect(normalizeProxyLink('[2606:4700::1111]:1080', 'direct', 'socks5').url).toBe(
      'socks5://[2606:4700::1111]:1080'
    );
  });
  it('将供应商凭据作为原文编码，保留动态会话占位符', () => {
    const result = normalizeProxyLink(
      'gateway.example.test:8080:user@region-{session}:p@ss:#/%20:{session}',
      'direct',
      'http'
    );
    const parsed = new URL(result.url);
    expect(decodeURIComponent(parsed.username)).toBe('user@region-{session}');
    expect(decodeURIComponent(parsed.password)).toBe('p@ss:#/%20:{session}');
    expect(result.url).toContain('{session}');
    expect(parsed.hostname).toBe('gateway.example.test');
  });
  it('提取链接独立使用所选协议，不将普通 HTTP 地址误当提取链接', () => {
    expect(
      normalizeProxyLink(
        'https://provider.example.test/extract?key=invalid',
        'extraction',
        'socks5'
      )
    ).toEqual({ url: 'https://provider.example.test/extract?key=invalid', protocol: 'socks5' });
    expect(() =>
      normalizeProxyLink('http://provider.example.test/extract', 'extraction', 'http')
    ).toThrow('HTTPS');
  });
  it.each([
    '',
    'gateway.example.test:0:demo:invalid',
    'gateway.example.test:65536:demo:invalid',
    'gateway.example.test:not-a-port:demo:invalid',
    'gateway.example.test:8080:demo',
    'gateway.example.test:8080::invalid',
    'ftp://demo:invalid@gateway.example.test:21',
    'socks5://gateway.example.test',
    'http://demo:%0Ainvalid@gateway.example.test:8080',
    'http://gateway.example.test:8080/unexpected',
    'http://gateway.example.test:8080#fragment',
    'http://demo:%ZZ@gateway.example.test:8080',
    'http://gateway.example.test:0'
  ])('拒绝无效输入且错误不回显代理凭据：%s', (url) => {
    let error = '';
    try {
      normalizeProxyLink(url, 'direct', 'http');
    } catch (cause) {
      error = (cause as Error).message;
    }
    expect(error).not.toBe('');
    expect(error).not.toContain('invalid');
    expect(error).not.toContain('demo');
  });
  it('整批先校验，行号计入空行且不输出输入内容', () => {
    expect(() =>
      normalizeProxyImport(
        'gateway.example.test:8080:demo:invalid\n\nprovider.example.test:bad:demo:private-value',
        'direct',
        'socks5'
      )
    ).toThrow('第 3 行');
    expect(() => normalizeProxyImport('private-value', 'direct', 'http')).toThrow(
      /^第 1 行：(?!.*private-value)/
    );
    expect(() =>
      normalizeProxyImport(
        Array(501).fill('gateway.example.test:8080').join('\n'),
        'direct',
        'http'
      )
    ).toThrow('500');
    expect(
      normalizeProxyImport(
        'gateway.example.test:8080:demo:invalid\nsocks5://proxy.example.test:1080',
        'direct',
        'https'
      )
    ).toEqual([
      { url: 'https://demo:invalid@gateway.example.test:8080', protocol: 'https' },
      { url: 'socks5://proxy.example.test:1080', protocol: 'socks5' }
    ]);
  });
});
