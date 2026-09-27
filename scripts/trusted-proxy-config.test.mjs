import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const caddyConfig = readFileSync('deploy/caddy/Caddyfile.aws', 'utf8');
const nginxConfig = readFileSync('deploy/nginx/admin.conf', 'utf8');
const composeConfig = readFileSync('docker-compose.aws-mysql.yml', 'utf8');

test('Caddy remains the first untrusted public edge for forwarding addresses', () => {
  assert.match(caddyConfig, /reverse_proxy admin:80/);
  assert.doesNotMatch(caddyConfig, /trusted_proxies/);
  assert.doesNotMatch(caddyConfig, /header_up X-Forwarded-For/);
});

test('Nginx forwards the single Caddy address without extending the proxy chain', () => {
  const proxyLocations = [...nginxConfig.matchAll(/location\s+([^{}]+)\{([^{}]*)\}/g)].filter(
    (match) => /proxy_pass\s/.test(match[2])
  );
  assert.equal(proxyLocations.length, 3);
  for (const [, location, block] of proxyLocations) {
    assert.match(block, /proxy_set_header X-Forwarded-For \$http_x_forwarded_for;/, location);
    assert.match(block, /proxy_set_header X-Real-IP \$http_x_forwarded_for;/, location);
    assert.match(block, /proxy_set_header X-Forwarded-Proto \$http_x_forwarded_proto;/, location);
  }
  assert.doesNotMatch(nginxConfig, /\$proxy_add_x_forwarded_for/);
});

test('media download uses its bounded timeout while ordinary API requests retain theirs', () => {
  const mediaBlock = nginxConfig.match(
    /location = \/api\/id-business-v2\/workspace-media\/download\s*\{([^{}]*)\}/
  )?.[1];
  const apiBlock = nginxConfig.match(/location \/api\/\s*\{([^{}]*)\}/)?.[1];
  assert.ok(mediaBlock, 'missing media download location');
  assert.ok(apiBlock, 'missing ordinary API location');
  assert.match(mediaBlock, /proxy_read_timeout 370s;/);
  assert.match(apiBlock, /proxy_read_timeout 120s;/);
});

test('API and admin remain internal services without host port mappings', () => {
  const apiBlock = composeConfig.match(/\n {2}api:\n([\s\S]*?)\n {2}admin:\n/)?.[1];
  const adminBlock = composeConfig.match(/\n {2}admin:\n([\s\S]*?)\n {2}caddy:\n/)?.[1];
  assert.ok(apiBlock, 'missing api service');
  assert.ok(adminBlock, 'missing admin service');
  assert.doesNotMatch(apiBlock, /^ {4}ports:/m);
  assert.doesNotMatch(adminBlock, /^ {4}ports:/m);
});
