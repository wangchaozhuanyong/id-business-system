import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');

describe('admin security headers', () => {
  it('loads the boot shell without inline script, style or event handlers', () => {
    expect(indexHtml).toContain('href="/v2-boot.css"');
    expect(indexHtml).toContain('src="/v2-boot.js"');
    expect(indexHtml).not.toMatch(/<style\b/i);
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(indexHtml).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('blocks untrusted script execution and cross-origin embedding', () => {
    expect(headers).toContain("script-src 'self'");
    expect(headers).not.toMatch(/script-src[^;\n]*'unsafe-inline'/);
    expect(headers).not.toMatch(/script-src[^;\n]*'unsafe-eval'/);
    expect(headers).toContain("object-src 'none'");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain('Permissions-Policy:');
    expect(headers).toContain('Strict-Transport-Security:');
  });

  it('limits API connections to the same origin and the fixed local connector', () => {
    expect(headers).toContain(
      "connect-src 'self' http://127.0.0.1:55321 http://localhost:55321;"
    );
    expect(headers).not.toMatch(/connect-src[^;\n]*https:\/\//);
    expect(headers).not.toMatch(/connect-src[^;\n]*http:\/\/(?!127\.0\.0\.1:55321|localhost:55321)/);
    expect(headers).not.toMatch(/connect-src[^;\n]*wss?:\/\//);
  });
});
