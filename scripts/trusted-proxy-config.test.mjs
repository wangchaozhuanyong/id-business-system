import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const caddyConfig = readFileSync('deploy/caddy/Caddyfile.aws', 'utf8');
const nginxConfig = readFileSync('deploy/nginx/admin.conf', 'utf8');
const composeConfig = readFileSync('docker-compose.aws-mysql.yml', 'utf8');
const controlledLocations = [
  '/api/realtime/',
  '= /api/id-business-v2/workspace-media/download',
  '= /api/id-business-v2/online-recharge/ws',
  '/api/'
];

function assertSingleCaddyAddress(config) {
  const proxyLocations = [...config.matchAll(/location\s+([^{}]+)\{([^{}]*)\}/g)].filter((match) =>
    /proxy_pass\s/.test(match[2])
  );
  assert.deepEqual(
    proxyLocations.map((match) => match[1].trim()).sort(),
    [...controlledLocations].sort()
  );
  for (const [, location, block] of proxyLocations) {
    for (const [header, value] of [
      ['X-Forwarded-For', '$http_x_forwarded_for'],
      ['X-Real-IP', '$http_x_forwarded_for'],
      ['X-Forwarded-Proto', '$http_x_forwarded_proto']
    ]) {
      const directives = [
        ...block.matchAll(
          new RegExp(`^[ \\t]*proxy_set_header[ \\t]+${header}[ \\t]+([^;]+);[ \\t]*$`, 'gim')
        )
      ].map((match) => match[1].trim());
      assert.deepEqual(directives, [value], `${location.trim()}: ${header}`);
    }
  }
  assert.doesNotMatch(config, /\$proxy_add_x_forwarded_for/);
}

test('Caddy remains the first untrusted public edge for forwarding addresses', () => {
  assert.match(caddyConfig, /reverse_proxy admin:80/);
  assert.doesNotMatch(caddyConfig, /trusted_proxies/);
  assert.doesNotMatch(caddyConfig, /header_up X-Forwarded-For/);
});

test('Nginx forwards the single Caddy address without extending the proxy chain', () => {
  assertSingleCaddyAddress(nginxConfig);
});

test('every controlled proxy rejects missing, duplicate or rewritten forwarding headers', () => {
  for (const location of controlledLocations) {
    const block = [...nginxConfig.matchAll(/location\s+([^{}]+)\{([^{}]*)\}/g)].find(
      (match) => match[1].trim() === location
    )[2];
    for (const header of ['X-Forwarded-For', 'X-Real-IP', 'X-Forwarded-Proto']) {
      const directive = block.match(new RegExp(`proxy_set_header ${header} [^;]+;`))[0];
      for (const replacement of [
        '',
        `${directive}\n    proxy_set_header ${header.toLowerCase()} $remote_addr;`,
        `proxy_set_header ${header} $remote_addr;`
      ]) {
        assert.throws(() =>
          assertSingleCaddyAddress(
            nginxConfig.replace(block, block.replace(directive, replacement))
          )
        );
      }
    }
    for (const address of ['$proxy_add_x_forwarded_for', '$http_x_forwarded_for, $remote_addr']) {
      const changed = block.replace(
        'X-Forwarded-For $http_x_forwarded_for;',
        `X-Forwarded-For ${address};`
      );
      assert.throws(() => assertSingleCaddyAddress(nginxConfig.replace(block, changed)));
    }
  }
});

test('online recharge gateway is required exactly once at its controlled WebSocket route', () => {
  const location = '= /api/id-business-v2/online-recharge/ws';
  const block = [...nginxConfig.matchAll(/location\s+([^{}]+)\{([^{}]*)\}/g)].find(
    (match) => match[1].trim() === location
  )[0];
  for (const changed of [
    nginxConfig.replace(block, ''),
    `${nginxConfig}\n${block}`,
    nginxConfig.replace(`location ${location}`, 'location /api/id-business-v2/online-recharge/')
  ])
    assert.throws(() => assertSingleCaddyAddress(changed));
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
