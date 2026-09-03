import { describe, expect, it } from 'vitest';
import {
  isPublicWebsiteAddress,
  normalizeV2WebsiteMonitorInput
} from './id-business-v2-website-monitor-input';

describe('website monitor input security', () => {
  it('normalizes public website addresses without keeping fragments', () => {
    expect(normalizeV2WebsiteMonitorInput('example.com/path#section').href).toBe(
      'https://example.com/path'
    );
    expect(normalizeV2WebsiteMonitorInput('http://example.com:8080/health').href).toBe(
      'http://example.com:8080/health'
    );
  });

  it('rejects credentials, unsupported protocols and local hostnames', () => {
    expect(() => normalizeV2WebsiteMonitorInput('ftp://example.com')).toThrow(
      '只支持 HTTP 或 HTTPS'
    );
    expect(() => normalizeV2WebsiteMonitorInput('https://user:pass@example.com')).toThrow(
      '不能包含账号或密码'
    );
    expect(() => normalizeV2WebsiteMonitorInput('http://service.internal/health')).toThrow(
      '只允许检测公开网站'
    );
    expect(() => normalizeV2WebsiteMonitorInput('http://127.0.0.1')).toThrow('只允许检测公开网站');
  });

  it('allows public IP addresses and blocks private, metadata and reserved ranges', () => {
    expect(isPublicWebsiteAddress('8.8.8.8')).toBe(true);
    expect(isPublicWebsiteAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicWebsiteAddress('10.0.0.1')).toBe(false);
    expect(isPublicWebsiteAddress('169.254.169.254')).toBe(false);
    expect(isPublicWebsiteAddress('192.168.1.10')).toBe(false);
    expect(isPublicWebsiteAddress('::1')).toBe(false);
    expect(isPublicWebsiteAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicWebsiteAddress('fc00::1')).toBe(false);
    expect(isPublicWebsiteAddress('2001:db8::1')).toBe(false);
  });
});
