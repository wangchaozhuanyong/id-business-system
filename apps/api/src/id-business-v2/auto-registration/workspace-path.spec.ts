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
  it.each([
    '/payment',
    '/api/payment/generate-link',
    '/api/payment/open-incognito',
    '/api/payment/accounts/1/mark-subscription',
    '/api/payment/accounts/batch-check-subscription',
    '/api/payment/accounts/1/upload-tm/extra'
  ])('拒绝已退役的订阅支付入口 %s', (path) => {
    expect(() => workspaceUpstreamPath(`${base}${path}`)).toThrow();
  });
  it('独立团队管理上传和凭据刷新导出继续保留', () => {
    for (const path of [
      '/api/payment/accounts/1/upload-tm',
      '/api/payment/accounts/batch-upload-tm',
      '/api/accounts/1/refresh-token',
      '/api/accounts/export/json'
    ])
      expect(workspaceUpstreamPath(`${base}${path}`)).toBe(path);
  });
});
