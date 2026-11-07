import { execFile } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { validateRuntimeOrigin } from './runtime-health.mjs';

export const NATIVE_NETWORK_PROOF_DOMAIN = 'id-business/codexdaichong/native-network-proof/v1';
const maximumProofLifetimeMs = 30_000;
const proofFields = ['v', 'nativeUrl', 'container', 'containerId', 'networkMode', 'ports', 'running', 'issuedAt', 'expiresAt'];
const stateFields = ['containerId', 'networkMode', 'ports', 'running'];
const exec = promisify(execFile);

function closedObject(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function checkedContainer(container) {
  if (typeof container !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container))
    throw new Error('原版服务需要指定可核验的独立私网容器');
  return container;
}

function checkedSecret(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32)
    throw new Error('网络证明需要有效的既有服务签名配置');
  return secret;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function signature(secret, encoded) {
  return createHmac('sha256', checkedSecret(secret))
    .update(NATIVE_NETWORK_PROOF_DOMAIN + '\0' + encoded).digest();
}

function validPort(value) {
  return typeof value === 'string' && /^[1-9]\d{0,4}$/.test(value) && Number(value) <= 65535;
}

function checkedNetworkState(state, native) {
  if (!closedObject(state, stateFields) || typeof state.containerId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(state.containerId) || state.running !== true ||
      typeof state.networkMode !== 'string' || !state.networkMode || state.networkMode.length > 256 ||
      ['host', 'none'].includes(state.networkMode) || state.networkMode.startsWith('container:') ||
      !state.ports || typeof state.ports !== 'object' || Array.isArray(state.ports))
    throw new Error('原版服务必须在运行中的独立私网容器内');
  let nativeTcp = false;
  let bindings = 0;
  const ports = Object.entries(state.ports);
  if (!ports.length || ports.length > 256) throw new Error('原版容器端口投影无效');
  for (const [port, values] of ports) {
    const match = /^([1-9]\d{0,4})\/(tcp|udp)$/.exec(port);
    if (!match || !validPort(match[1]) ||
        (values !== null && (!Array.isArray(values) || !values.length || values.length > 64)))
      throw new Error('原版容器端口投影无效');
    for (const binding of values ?? []) {
      if (!closedObject(binding, ['HostIp', 'HostPort']) || binding.HostIp !== '127.0.0.1' ||
          !validPort(binding.HostPort))
        throw new Error('原版端口必须只映射到本机回环，禁止公开原版接口');
      bindings++;
      if (match[2] === 'tcp' && binding.HostPort === native.port) nativeTcp = true;
    }
  }
  if (!bindings || !nativeTcp)
    throw new Error('原版端口必须只映射到本机回环，禁止公开原版接口');
  return state;
}

async function inspectContainer(container) {
  const format = '{{json .Id}}\n{{json .HostConfig.NetworkMode}}\n{{json .NetworkSettings.Ports}}\n{{json .State.Running}}';
  const { stdout } = await exec('docker', ['inspect', '--format', format, container], {
    timeout: 5000, maxBuffer: 128 * 1024
  });
  const [containerId, networkMode, ports, running] = stdout.trim().split('\n').map((line) => JSON.parse(line));
  return { containerId, networkMode, ports, running };
}

/** Host-side signer. Supply the real docker inspect projection; no proof is written to disk. */
export function signNativeNetworkProof({ nativeUrl, container, state, secret, now = Date.now(), ttlMs = 30_000 }) {
  const native = new URL(validateRuntimeOrigin(nativeUrl));
  checkedContainer(container);
  checkedNetworkState(state, native);
  if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 || ttlMs > maximumProofLifetimeMs || !Number.isSafeInteger(now + ttlMs))
    throw new Error('网络证明有效期无效');
  const payload = { v: 1, nativeUrl: native.origin, container, ...state, issuedAt: now, expiresAt: now + ttlMs };
  const encoded = Buffer.from(canonicalJson(payload)).toString('base64url');
  if (encoded.length > 32_768) throw new Error('网络证明超过大小限制');
  return encoded + '.' + signature(secret, encoded).toString('base64url');
}

/** Verify exact evidence and reapply all network rules; never trust an isolation boolean. */
export function verifyNativeNetworkProof({ proof, nativeUrl, container, secret, now = Date.now() }) {
  const native = new URL(validateRuntimeOrigin(nativeUrl));
  checkedContainer(container);
  if (typeof proof !== 'string' || proof.length > 32_812)
    throw new Error('网络证明格式无效');
  const [encoded, signed, extra] = proof.split('.');
  if (extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(encoded ?? '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(signed ?? ''))
    throw new Error('网络证明格式无效');
  const actual = Buffer.from(signed, 'base64url');
  const expected = signature(secret, encoded);
  if (actual.length !== expected.length || actual.toString('base64url') !== signed ||
      !timingSafeEqual(actual, expected)) throw new Error('网络证明签名无效');
  const raw = Buffer.from(encoded, 'base64url');
  if (raw.toString('base64url') !== encoded) throw new Error('网络证明编码无效');
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); }
  catch { throw new Error('网络证明格式无效'); }
  if (!closedObject(payload, proofFields) || canonicalJson(payload) !== raw.toString('utf8') ||
      payload.v !== 1 || payload.nativeUrl !== native.origin || payload.container !== container)
    throw new Error('网络证明与目标服务不一致');
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(payload.issuedAt) ||
      !Number.isSafeInteger(payload.expiresAt) || payload.issuedAt <= 0 ||
      payload.issuedAt > now || payload.expiresAt <= now ||
      payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > maximumProofLifetimeMs)
    throw new Error('网络证明已过期或签发时间无效');
  return checkedNetworkState({ containerId: payload.containerId, networkMode: payload.networkMode,
    ports: payload.ports, running: payload.running }, native);
}

/** Use a host-signed short-lived snapshot in a socket-free adapter, otherwise inspect directly. */
export async function verifyNativeNetworkIsolation({ nativeUrl, container, inspect = inspectContainer, proof, secret, now = Date.now() }) {
  const native = new URL(validateRuntimeOrigin(nativeUrl));
  checkedContainer(container);
  if (proof !== undefined && proof !== '') {
    verifyNativeNetworkProof({ proof, nativeUrl, container, secret, now });
  } else {
    let state;
    try { state = await inspect(container); }
    catch { throw new Error('无法核验原版服务的实际网络隔离'); }
    checkedNetworkState(state, native);
  }
  return { isolated: true };
}
