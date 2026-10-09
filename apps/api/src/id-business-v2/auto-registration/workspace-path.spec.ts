import { describe, expect, it } from 'vitest';
import { isWorkspaceSensitiveRead, workspaceUpstreamPath } from './workspace-path';

const base = '/api/id-business-v2/auto-registration/workspace';
describe('自动注册代理边界', () => {
  it('仅保留原模块允许的页面与接口', () => {
    expect(workspaceUpstreamPath(`${base}/api/accounts?search=test&page=2`)).toBe(
      '/api/accounts?search=test&page=2'
    );
    expect(workspaceUpstreamPath(`${base}/`)).toBe('/');
    expect(workspaceUpstreamPath(`${base}/static/js/app.js`)).toBe('/static/js/app.js');
  });
  it.each([
    '/../../auth',
    '/%2e%2e/settings',
    '//example.com',
    '/api/auth/login',
    '/static/%252e%252e/foo',
    '/static/a%5cb',
    '/login'
  ])('拒绝逃逸地址 %s', (suffix) => {
    expect(() => workspaceUpstreamPath(`${base}${suffix}`)).toThrow();
  });
  it('敏感查看和导出必须经过审计', () => {
    expect(isWorkspaceSensitiveRead('GET', '/api/accounts')).toBe(false);
    expect(isWorkspaceSensitiveRead('GET', '/api/accounts/1/credentials')).toBe(true);
    expect(isWorkspaceSensitiveRead('GET', '/api/email-services/2/full')).toBe(true);
    expect(isWorkspaceSensitiveRead('POST', '/api/accounts/export/json')).toBe(true);
  });
});
