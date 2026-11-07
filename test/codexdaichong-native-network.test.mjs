import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  NATIVE_NETWORK_PROOF_DOMAIN, signNativeNetworkProof, verifyNativeNetworkIsolation, verifyNativeNetworkProof
} from '../modules/recharge/codexdaichong/native-network.mjs';

const now = 1_800_000_000_000;
const nativeUrl = 'http://127.0.0.1:31993';
const container = 'synthetic-private-native';
const state = {
  containerId: 'a'.repeat(64), networkMode: 'private-native', running: true,
  ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '31993' }], '19222/tcp': null }
};

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

// Deliberately sign unsafe payloads to ensure signature verification cannot bypass network rules.
function signedPayload(payload, secret, raw = canonical(payload)) {
  const encoded = Buffer.from(raw).toString('base64url');
  return encoded + '.' + createHmac('sha256', secret)
    .update(NATIVE_NETWORK_PROOF_DOMAIN + '\0' + encoded).digest('base64url');
}

test('host-signed evidence is bound to native URL, container name, identity and exact network state without Docker inside the adapter', async () => {
  const secret = randomBytes(32).toString('hex');
  const proof = signNativeNetworkProof({ nativeUrl, container, state, secret, now });
  assert.deepEqual(verifyNativeNetworkProof({ nativeUrl, container, proof, secret, now }), state);
  let inspected = false;
  assert.deepEqual(await verifyNativeNetworkIsolation({ nativeUrl, container, proof, secret, now,
    inspect: async () => { inspected = true; throw new Error('Docker unavailable in adapter'); }
  }), { isolated: true });
  assert.equal(inspected, false);
  for (const changed of [
    { nativeUrl: 'http://127.0.0.1:31994' }, { container: 'another-container' },
    { secret: randomBytes(32).toString('hex') }, { proof: proof + '.extra' }, { proof: true }
  ]) assert.throws(() => verifyNativeNetworkProof({ nativeUrl, container, proof, secret, now, ...changed }));
  const payload = JSON.parse(Buffer.from(proof.split('.')[0], 'base64url'));
  assert.equal(payload.containerId, state.containerId);
  const forged = { ...payload, containerId: 'b'.repeat(64) };
  const forgedEncoded = Buffer.from(canonical(forged)).toString('base64url');
  assert.throws(() => verifyNativeNetworkProof({ nativeUrl, container, secret, now,
    proof: forgedEncoded + '.' + proof.split('.')[1] }), /签名/);
});

test('network evidence expires within thirty seconds and rejects future issuance, stale proof and non-closed payloads', () => {
  const secret = randomBytes(32).toString('hex');
  const proof = signNativeNetworkProof({ nativeUrl, container, state, secret, now });
  const payload = JSON.parse(Buffer.from(proof.split('.')[0], 'base64url'));
  assert.throws(() => verifyNativeNetworkProof({ nativeUrl, container, proof, secret, now: now + 30_000 }), /过期/);
  assert.throws(() => signNativeNetworkProof({ nativeUrl, container, state, secret, now, ttlMs: 30_001 }), /有效期/);
  for (const changed of [
    { issuedAt: now + 1, expiresAt: now + 30_000 },
    { issuedAt: now - 40_000, expiresAt: now + 1 },
    { expiresAt: payload.issuedAt }, { issuedAt: String(now) },
    { isolated: true }, { containerId: 'not-a-container-id' }, { v: 2 }
  ]) assert.throws(() => verifyNativeNetworkProof({ nativeUrl, container, secret, now,
    proof: signedPayload({ ...payload, ...changed }, secret) }));
  const extra = { ...payload };
  delete extra.containerId;
  assert.throws(() => verifyNativeNetworkProof({ nativeUrl, container, secret, now,
    proof: signedPayload(extra, secret) }));
  const nonCanonical = JSON.stringify(payload, null, 2);
  assert.throws(() => verifyNativeNetworkProof({ nativeUrl, container, secret, now,
    proof: signedPayload(payload, secret, nonCanonical) }), /目标服务/);
});

test('a valid host signature still cannot approve host networking, public bindings, stopped services or UDP-only publication', () => {
  const secret = randomBytes(32).toString('hex');
  const proof = signNativeNetworkProof({ nativeUrl, container, state, secret, now });
  const payload = JSON.parse(Buffer.from(proof.split('.')[0], 'base64url'));
  for (const changed of [
    { networkMode: 'host' }, { networkMode: 'none' }, { networkMode: 'container:another' },
    { running: false },
    { ports: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '31993' }] } },
    { ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '31994' }] } },
    { ports: { '3000/udp': [{ HostIp: '127.0.0.1', HostPort: '31993' }] } },
    { ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '31993', public: false }] } },
    { ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '99999' }] } },
    { ports: { '3000/tcp': null } }
  ]) {
    assert.throws(() => signNativeNetworkProof({ nativeUrl, container, secret, now, state: { ...state, ...changed } }));
    assert.throws(() => verifyNativeNetworkProof({ nativeUrl, container, secret, now,
      proof: signedPayload({ ...payload, ...changed }, secret) }));
  }
});

test('proof-free callers retain actual inspect and cannot use booleans as network evidence', async () => {
  let inspected = 0;
  const inspect = async (name) => { assert.equal(name, container); inspected++; return state; };
  assert.deepEqual(await verifyNativeNetworkIsolation({ nativeUrl, container, inspect }), { isolated: true });
  assert.deepEqual(await verifyNativeNetworkIsolation({ nativeUrl, container, inspect, proof: '' }), { isolated: true });
  assert.equal(inspected, 2);
  await assert.rejects(verifyNativeNetworkIsolation({ nativeUrl, container, inspect, proof: true }));
  assert.equal(inspected, 2);
  await assert.rejects(verifyNativeNetworkIsolation({ nativeUrl, container,
    inspect: async () => ({ isolated: true }) }));
});

test('Python host launcher produces the identical compact canonical proof without writing credentials or evidence', () => {
  const secret = randomBytes(32).toString('hex');
  const expected = signNativeNetworkProof({ nativeUrl, container, state, secret, now });
  const payload = { v: 1, nativeUrl, container, ...state, issuedAt: now, expiresAt: now + 30_000 };
  const actual = execFileSync('python3', ['-c', `import base64, hashlib, hmac, json, sys
value = json.load(sys.stdin)
raw = json.dumps(value['payload'], sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
encoded = base64.urlsafe_b64encode(raw).rstrip(b'=')
signed = hmac.new(value['secret'].encode('utf-8'), b'id-business/codexdaichong/native-network-proof/v1\\0' + encoded, hashlib.sha256).digest()
sys.stdout.write((encoded + b'.' + base64.urlsafe_b64encode(signed).rstrip(b'=')).decode('ascii'))`], {
    input: JSON.stringify({ payload, secret }), encoding: 'utf8'
  });
  assert.equal(actual, expected);
  assert.deepEqual(verifyNativeNetworkProof({ nativeUrl, container, proof: actual, secret, now }), state);
});
