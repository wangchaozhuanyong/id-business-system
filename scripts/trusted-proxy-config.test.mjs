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
  assert.equal(
    nginxConfig.match(/proxy_set_header X-Forwarded-For \$http_x_forwarded_for;/g)?.length,
    2
  );
  assert.equal(nginxConfig.match(/proxy_set_header X-Real-IP \$http_x_forwarded_for;/g)?.length, 2);
  assert.equal(
    nginxConfig.match(/proxy_set_header X-Forwarded-Proto \$http_x_forwarded_proto;/g)?.length,
    2
  );
  assert.doesNotMatch(nginxConfig, /\$proxy_add_x_forwarded_for/);
});

test('API and admin remain internal services without host port mappings', () => {
  const apiBlock = composeConfig.match(/\n {2}api:\n([\s\S]*?)\n {2}admin:\n/)?.[1];
  const adminBlock = composeConfig.match(/\n {2}admin:\n([\s\S]*?)\n {2}caddy:\n/)?.[1];
  assert.ok(apiBlock, 'missing api service');
  assert.ok(adminBlock, 'missing admin service');
  assert.doesNotMatch(apiBlock, /^ {4}ports:/m);
  assert.doesNotMatch(adminBlock, /^ {4}ports:/m);
});
