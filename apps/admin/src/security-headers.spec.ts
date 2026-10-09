import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

const caddyConfig = readFileSync(
  new URL('../../../deploy/caddy/Caddyfile.aws', import.meta.url),
  'utf8'
);

function directiveSources(source: string, directive: string) {
  return new RegExp(`\\b${directive} ([^;\\n"]+);`).exec(source)?.[1]?.trim().split(/\s+/);
}

function caddyHandlerBody(matcher: string) {
  const start = new RegExp(`\\bhandle\\s*${matcher}\\s*\\{`).exec(caddyConfig);
  if (!start) return undefined;
  const bodyStart = start.index + start[0].length;
  let depth = 1;
  let quoted = false;
  for (let index = bodyStart; index < caddyConfig.length; index += 1) {
    const character = caddyConfig[index];
    if (character === '"' && caddyConfig[index - 1] !== '\\') quoted = !quoted;
    if (quoted) continue;
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    if (depth === 0) return caddyConfig.slice(bodyStart, index);
  }
  return undefined;
}

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

  it.each([
    ['public headers', headers],
    ['Vite generated headers', viteConfig],
    ['production edge headers', caddyConfig]
  ])('allows only same-origin child frames in %s while protecting the parent', (_name, source) => {
    expect(directiveSources(source, 'frame-src')).toEqual(["'self'"]);
    expect(directiveSources(source, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directiveSources(source, 'script-src')).toEqual(["'self'"]);
    expect(source).toMatch(/X-Frame-Options(?::|\s)\s*DENY/);
  });

  it('proxies the registration workspace to the API before the ordinary admin fallback', () => {
    const workspacePath = '/api/id-business-v2/auto-registration/workspace';
    const paths = /@registrationWorkspace\s+path\s+([^\n]+)/
      .exec(caddyConfig)?.[1]
      ?.trim()
      .split(/\s+/);
    expect(paths).toEqual([workspacePath, `${workspacePath}/*`]);

    const workspaceHandler = caddyHandlerBody('@registrationWorkspace');
    expect(workspaceHandler).toBeDefined();
    expect(workspaceHandler).toMatch(/\breverse_proxy\s+api:3000\s*\{/);
    expect(workspaceHandler).toMatch(/\bflush_interval\s+-1\b/);
    expect(workspaceHandler).not.toMatch(/handle_path|strip_prefix|\brewrite\b/);
    expect(workspaceHandler).not.toMatch(/Content-Security-Policy|X-Frame-Options/);

    const adminHandler = caddyHandlerBody('');
    expect(adminHandler).toMatch(/\breverse_proxy\s+admin:80\b/);
    expect(adminHandler).toContain("frame-src 'self'");
    expect(adminHandler).toContain("frame-ancestors 'none'");
    expect(adminHandler).toMatch(/X-Frame-Options\s+DENY/);
    expect(caddyConfig.match(/Content-Security-Policy/g)).toHaveLength(1);
    expect(caddyConfig.match(/X-Frame-Options/g)).toHaveLength(1);
    expect(caddyConfig.indexOf('handle @registrationWorkspace')).toBeLessThan(
      caddyConfig.search(/\bhandle\s*\{/)
    );
  });

  it('limits API and window control connections to the same origin and loopback hosts', () => {
    const sources = /connect-src ([^;]+);/.exec(headers)?.[1]?.split(' ');
    expect(sources).toEqual([
      "'self'",
      'http://127.0.0.1:*',
      'http://localhost:*',
      'ws://127.0.0.1:*',
      'ws://localhost:*'
    ]);
    expect(viteConfig).toContain(`connect-src ${sources?.join(' ')};`);
    expect(caddyConfig).toContain(`connect-src ${sources?.join(' ')};`);
  });
});
