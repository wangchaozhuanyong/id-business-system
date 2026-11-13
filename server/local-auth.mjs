import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { openLocalSessionStore } from './local-auth-sessions.mjs';
import { staffRoles } from './access-roles.mjs';
import {
  allowsNetwork, bindAuthenticator, browserLifetime, createLoginThrottle, newAuthenticator,
  readNetwork, useAuthenticator, verificationLifetime, verifiedAddress, verifyTurnstile
} from './login-security.mjs';

export const localAdminEmail = 'ppfzj1314@gmail.com';
const localCookieName = 'id_local_session';
const sessionLifetime = 8 * 60 * 60 * 1000;
const day = 24 * 60 * 60 * 1000;
const rememberedIdleLifetime = 30 * day;
const rememberedMaximumLifetime = 90 * day;
const employeeRoles = staffRoles;
const tokenPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[0-9a-f-]{36}$/;
const derive = promisify(scrypt);
const scryptOptions = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const dummyCredential = { salt: randomBytes(24).toString('hex'), hash: '0'.repeat(128) };

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validatedEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    email.length > 254 ||
    !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(email)
  ) {
    throw new AuthError(400, '请填写有效的员工邮箱');
  }
  return email;
}

function validatedName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || [...name].length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new AuthError(400, '请填写 1 至 80 个字符的员工姓名');
  }
  return name;
}

function validatedPassword(value) {
  if (
    typeof value !== 'string' ||
    [...value].length < 12 ||
    [...value].length > 128 ||
    Buffer.byteLength(value, 'utf8') > 512 ||
    /[\u0000\r\n]/.test(value)
  ) {
    throw new AuthError(400, '密码须为 12 至 128 个字符，且不能包含换行');
  }
  return value;
}

async function createCredential(password) {
  const salt = randomBytes(24);
  const hash = await derive(validatedPassword(password), salt, 64, scryptOptions);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

async function matchesCredential(password, { salt, hash }) {
  const candidate = await derive(password, Buffer.from(salt, 'hex'), 64, scryptOptions);
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

function publicEmployee({ id, email, name, nicknameSet, role, active, version, createdAt, updatedAt, mfa, teamLeadId }) {
  return { id, email, name, nicknameSet: nicknameSet === true, role, active, version, createdAt, updatedAt,
    ...(mfa ? { mfaBound: true } : {}), ...(teamLeadId ? { teamLeadId } : {}) };
}

function readAccounts(accountPath) {
  let descriptor;
  try {
    descriptor = openSync(
      accountPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const file = fstatSync(descriptor);
    if (
      !file.isFile() ||
      file.size > 1024 * 1024 ||
      (file.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && file.uid !== process.getuid())
    ) {
      throw new Error('本机员工配置的文件或权限不正确');
    }
    let data;
    try {
      data = JSON.parse(readFileSync(descriptor, 'utf8'));
    } catch {
      throw new Error('本机员工配置格式不正确');
    }
    if (data?.schema !== 1 || !Array.isArray(data.employees)) {
      throw new Error('本机员工配置格式不正确');
    }
    const ids = new Set();
    const emails = new Set();
    let supervisors = 0;
    for (const employee of data.employees) {
      if (
        !employee ||
        !idPattern.test(employee.id) ||
        ids.has(employee.id) ||
        validatedEmail(employee.email) !== employee.email ||
        emails.has(employee.email) ||
        validatedName(employee.name) !== employee.name ||
        (employee.nicknameSet !== undefined && typeof employee.nicknameSet !== 'boolean') ||
        typeof employee.active !== 'boolean' ||
        !Number.isSafeInteger(employee.version) ||
        employee.version < 1 ||
        !Number.isSafeInteger(employee.sessionVersion) ||
        employee.sessionVersion < 1 ||
        (employee.role !== 'super' && !employeeRoles.has(employee.role)) ||
        !/^[0-9a-f]{48}$/.test(employee.credential?.salt) ||
        !/^[0-9a-f]{128}$/.test(employee.credential?.hash) ||
        (employee.teamLeadId !== undefined && !idPattern.test(employee.teamLeadId)) ||
        (employee.mfa !== undefined && (!/^[0-9a-f]{96}$/.test(employee.mfa?.seed) ||
          !Number.isSafeInteger(employee.mfa.lastStep) || !Array.isArray(employee.mfa.recovery) ||
          employee.mfa.recovery.length > 8 || employee.mfa.recovery.some(code => !tokenPattern.test(code)))) ||
        (employee.deviceLock !== undefined && typeof employee.deviceLock !== 'boolean') ||
        (employee.trustedDevices !== undefined && (!Array.isArray(employee.trustedDevices) || employee.trustedDevices.length > 12 ||
          employee.trustedDevices.some(row => !idPattern.test(row?.id) || !tokenPattern.test(row.digest) ||
            typeof row.name !== 'string' || !Number.isSafeInteger(row.at) ||
            !['pending', 'approved'].includes(row.state))))
      ) {
        throw new Error('本机员工账号配置无效');
      }
      ids.add(employee.id);
      emails.add(employee.email);
      if (employee.role === 'super' && employee.active) supervisors++;
    }
    if (supervisors !== 1 || data.employees.filter(({ role }) => role === 'super').length !== 1) {
      throw new Error('本机员工配置需要一个已启用的超级管理员');
    }
    if (data.networkPolicy !== undefined && (!['observe', 'enforce'].includes(data.networkPolicy?.mode) ||
        !Number.isSafeInteger(data.networkPolicy.version) || !Array.isArray(data.networkPolicy.entries) ||
        data.networkPolicy.entries.length > 24 || data.networkPolicy.entries.some(row =>
          !idPattern.test(row?.id) || typeof row.name !== 'string' || !readNetwork(row.network))))
      throw new Error('登录网络名单格式不正确');
    return data;
  } finally {
    closeSync(descriptor);
  }
}

function writeAccounts(accountPath, accounts, { initialize = false } = {}) {
  const stagingPath = accountPath + '.' + randomUUID() + '.tmp';
  const descriptor = openSync(stagingPath, 'wx', 0o600);
  try {
    try {
      writeFileSync(descriptor, JSON.stringify(accounts) + '\n', 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (initialize) linkSync(stagingPath, accountPath);
    else renameSync(stagingPath, accountPath);
  } finally {
    try {
      unlinkSync(stagingPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function changeAccounts(accountPath, change) {
  const lockPath = accountPath + '.lock';
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new AuthError(409, '员工资料正在保存，请稍后重试');
    throw error;
  }
  try {
    const accounts = readAccounts(accountPath);
    if (!accounts) throw new AuthError(404, '未找到员工账户资料');
    const result = change(accounts);
    writeAccounts(accountPath, accounts);
    return result;
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

export function recoverLocalLogin(accountPath, { action, confirmation, employeeId, now = Date.now() }) {
  if (confirmation !== 'RECOVER-LOGIN') throw new AuthError(400, '请明确确认登录恢复操作');
  return changeAccounts(accountPath, accounts => {
    const employee = accounts.employees.find(row => row.id === employeeId && row.active);
    if (action === 'network') {
      if (accounts.networkPolicy?.mode !== 'enforce') throw new AuthError(409, '登录网络限制当前未启用');
      accounts.networkPolicy.mode = 'observe';
      accounts.networkPolicy.version++;
    } else if (action === 'device' && employee?.deviceLock) {
      revokeDeviceTrust(employee, now);
    } else if (action === 'authenticator' && employee?.mfa) {
      delete employee.mfa;
      revokeDeviceTrust(employee, now);
    } else {
      throw new AuthError(400, '请选择已启用限制的恢复对象');
    }
    const owner = accounts.employees.find(row => row.role === 'super');
    const row = { id: randomUUID(), at: new Date(now).toISOString(), action,
      actor: publicEmployee(owner), targetId: action === 'network' ? '登录网络' : employee.id };
    accounts.lastSecurityRecovery = row;
    return { action, targetId: row.targetId, at: row.at };
  });
}

export async function initializeLocalAdmin(accountPath, { email, name, password }) {
  if (readAccounts(accountPath)) throw new AuthError(409, '本机超级管理员已经初始化');
  const adminEmail = validatedEmail(email);
  const adminName = validatedName(name);
  const credential = await createCredential(password);
  const at = new Date().toISOString();
  const employee = {
    id: randomUUID(),
    email: adminEmail,
    name: adminName,
    role: 'super',
    active: true,
    credential,
    version: 1,
    sessionVersion: 1,
    createdAt: at,
    updatedAt: at
  };
  mkdirSync(dirname(accountPath), { recursive: true, mode: 0o700 });
  try {
    writeAccounts(accountPath, { schema: 1, employees: [employee] }, { initialize: true });
  } catch (error) {
    if (error.code === 'EEXIST') throw new AuthError(409, '本机超级管理员已经初始化');
    throw error;
  }
  return publicEmployee(employee);
}

function revokeDeviceTrust(employee, at) {
  employee.deviceLock = false;
  employee.trustedDevices = [];
  employee.version++;
  employee.sessionVersion++;
  employee.updatedAt = new Date(at).toISOString();
}

function requestCookie(request, cookieName) {
  const cookies = String(request.headers.cookie || '').split(';');
  const matches = cookies
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.startsWith(cookieName + '='));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(cookieName.length + 1);
  return tokenPattern.test(token) ? token : null;
}
function requestToken(request, cookieName) {
  const token = requestCookie(request, cookieName);
  return token ? createHash('sha256').update(token).digest('hex') : null;
}

function setCookie(response, token, lifetime, cookieName, secure, alsoClear = []) {
  const value = (name, token, age) => `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(age / 1000)}${secure ? '; Secure' : ''}`;
  response.setHeader(
    'Set-Cookie',
    alsoClear.length ? [value(cookieName, token, lifetime), ...alsoClear.map(name => value(name, '', 0))]
      : value(cookieName, token, lifetime)
  );
}

function appendCookie(response, name, token, age, secure) {
  const value = `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(age / 1000)}${secure ? '; Secure' : ''}`;
  const existing = response.getHeader('Set-Cookie');
  response.setHeader('Set-Cookie', existing ? [].concat(existing, value) : value);
}

function browserName(request) {
  const agent = String(request.headers['user-agent'] || '').slice(0, 512);
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox'
    : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : '浏览器';
  const platform = /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS'
    : /Macintosh/.test(agent) ? 'macOS' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '未知设备';
  return browser + ' · ' + platform;
}

function setTeamLead(employees, employee, teamLeadId) {
  if (employee.role !== 'employee') {
    delete employee.teamLeadId;
    return;
  }
  if (teamLeadId === '') delete employee.teamLeadId;
  else if (teamLeadId !== undefined) {
    if (!employees.some(row => row.id === teamLeadId && row.role === 'supervisor' && row.active))
      throw new AuthError(400, '请选择已启用的主管');
    employee.teamLeadId = teamLeadId;
  }
}

function checkOrigin(request, publicUrl) {
  const host = request.headers.host || '';
  const expectedOrigin = publicUrl?.origin || 'http://' + host;
  const fetchSite = request.headers['sec-fetch-site'];
  if (
    (publicUrl ? host !== publicUrl.host : !/^(?:127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(host)) ||
    (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') ||
    (request.headers.origin && request.headers.origin !== expectedOrigin) ||
    (request.method !== 'GET' && request.headers.origin !== expectedOrigin)
  ) {
    throw new AuthError(403, '仅可通过本系统业务页面访问员工账户');
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(value));
}

async function parseJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw new AuthError(415, '请提交 JSON 资料');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 16_384) {
      request.resume();
      throw new AuthError(413, '请求资料过大');
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AuthError(400, '请求资料格式不正确');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthError(400, '请求资料格式不正确');
  }
  return value;
}

export function createLocalAdminSetup(accountPath, { onCreated } = {}) {
  let saving = false;
  return async (request, response) => {
    try {
      checkOrigin(request);
      if (request.method !== 'POST' || request.headers['sec-fetch-site'] !== 'same-origin') {
        throw new AuthError(403, '请从本机测试站的密码设置页面提交');
      }
      if (saving) throw new AuthError(409, '正在设置管理员，请稍后重试');
      const body = await parseJson(request);
      if (saving) throw new AuthError(409, '正在设置管理员，请稍后重试');
      if (body.password !== body.confirmation) throw new AuthError(400, '两次密码输入不一致');
      saving = true;
      try {
        const employee = await initializeLocalAdmin(accountPath, {
          email: localAdminEmail,
          name: '本机超级管理员',
          password: body.password
        });
        try {
          await onCreated?.(employee);
        } catch {
          // The account was committed before the audit write.
        }
      } finally {
        saving = false;
      }
      sendJson(response, 201, { configured: true });
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      sendJson(response, error instanceof AuthError ? error.status : 500, {
        error: error instanceof AuthError ? error.message : '无法设置本机管理员，请重试'
      });
    }
  };
}

export function createLocalAuth(accountPath, { onEvent, onMonitoring, now = Date.now, publicUrl, security, turnstileFetch } = {}) {
  const monitoringKey = onMonitoring && randomBytes(32);
  function monitor(kind, email) {
    if (!onMonitoring) return;
    try {
      onMonitoring({ kind, ...(email && email.length <= 254 && {
        accountKey: createHmac('sha256', monitoringKey).update(email).digest('hex')
      }) });
    } catch { /* Auth decisions do not depend on monitoring. */ }
  }
  if (!readAccounts(accountPath)) return null;
  const legacyCookieName = publicUrl ? '__Host-id_session' : localCookieName;
  const cookieName = legacyCookieName + '_v2';
  const browserCookie = publicUrl ? '__Host-id_approved_browser' : 'id_local_approved_browser';
  const sessions = publicUrl ? openLocalSessionStore(accountPath + '.sessions') : new Map();
  const allowAttempt = createLoginThrottle(now);
  const loginChecks = new Map();
  const enrollmentChecks = new Map();
  const challengeTokens = new Map();
  const loginProtectionEvents = [];
  let verifying = 0;
  let validatingChallenge = 0;

  function protectionEvent(kind) {
    const at = now();
    loginProtectionEvents.push({ kind, at });
    if (loginProtectionEvents.length > 500) loginProtectionEvents.shift();
  }

  function newCheck(collection, value) {
    const at = now();
    for (const [token, row] of collection) if (row.expiresAt <= at) collection.delete(token);
    if (collection.size >= 256) collection.delete(collection.keys().next().value);
    const token = randomBytes(32).toString('hex');
    collection.set(token, { ...value, expiresAt: at + verificationLifetime });
    return token;
  }

  function currentNetwork(request, accounts) {
    const address = verifiedAddress(request, security);
    const allowed = allowsNetwork(accounts.networkPolicy, address);
    if (!allowed) request.localAuthReason = 'network';
    return { address, allowed };
  }

  function checkNetwork(request, accounts) {
    const network = currentNetwork(request, accounts);
    if (!network.allowed) {
      protectionEvent('network');
      throw new AuthError(403, '当前网络尚未获准登录，请连接公司允许的网络或联系管理员');
    }
    return network.address;
  }

  function throttle(response, kind, account, source) {
    if (allowAttempt(kind, account, source)) return;
    protectionEvent('limited');
    monitor('limited', account);
    response.setHeader('Retry-After', '60');
    throw new AuthError(429, '尝试过于频繁，请等 1 分钟再试');
  }

  function selectedCookie(request) {
    // An explicitly present new cookie (including an invalid duplicate) must
    // never fall back to a different identity in a leftover legacy cookie.
    return String(request.headers.cookie || '').split(';').some(value => value.trim().startsWith(cookieName + '='))
      ? cookieName : legacyCookieName;
  }
  const sessionToken = request => requestToken(request, selectedCookie(request));
  function removeBrowserSessions(request) {
    for (const name of [cookieName, legacyCookieName]) {
      const digest = requestToken(request, name);
      if (digest) sessions.delete(digest);
    }
  }

  function updateSession(digest, change) {
    if (sessions.update) return sessions.update(digest, change);
    const current = sessions.get(digest);
    if (!current) return undefined;
    const next = change(current);
    if (next) sessions.set(digest, next);
    return next;
  }

  function sessionMetadata(session) {
    // Old eight-hour sessions remain eight-hour sessions after a deployment.
    return session.id ? session : {
      ...session, id: randomUUID(), remembered: false,
      createdAt: session.expiresAt - sessionLifetime,
      lastUsedAt: session.expiresAt - sessionLifetime,
      absoluteExpiresAt: session.expiresAt,
      device: '更新前的登录设备'
    };
  }

  function actorRecord(request, accounts) {
    const token = sessionToken(request);
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) { request.localAuthReason = 'invalid'; return null; }
    const current = accounts === undefined ? readAccounts(accountPath) : accounts;
    if (!current) throw new Error('账号存储暂不可用');
    const employee = current?.employees.find((row) => row.id === session.employeeId);
    if (
      session.expiresAt <= now() ||
      !employee?.active ||
      employee.sessionVersion !== session.version
    ) {
      request.localAuthReason = session.expiresAt <= now() ? 'expired' : 'revoked';
      return null;
    }
    if (!currentNetwork(request, current).allowed) return null;
    if (employee.deviceLock && (!session.deviceDigest ||
        session.deviceDigest !== requestToken(request, browserCookie) ||
        !employee.trustedDevices?.some(row => row.digest === session.deviceDigest && row.state === 'approved'))) {
      request.localAuthReason = 'device';
      return null;
    }
    return employee;
  }

  function getActor(request, { throwOnUnavailable = false } = {}) {
    try {
      const employee = actorRecord(request);
      return employee ? publicEmployee(employee) : null;
    } catch (error) {
      if (throwOnUnavailable) throw error;
      request.localAuthUnavailable = true;
      return null;
    }
  }
  function orderOwners() {
    return readAccounts(accountPath).employees.filter(row => row.active)
      .map(({ id, name, role }) => ({ id, name, role }));
  }

  function requireActor(request, accounts) {
    const employee = actorRecord(request, accounts);
    if (!employee) throw new AuthError(401, '登录已过期或已失效，请重新登录');
    return employee;
  }

  function requireSuper(request, accounts) {
    const employee = requireActor(request, accounts);
    if (employee.role !== 'super') throw new AuthError(403, '仅超级管理员可管理员工账户');
    return employee;
  }

  function recentlyVerified(request) {
    const token = sessionToken(request);
    const verifiedAt = token ? sessions.get(token)?.verifiedAt : null;
    return Boolean(security?.mfaKey && Number.isSafeInteger(verifiedAt) &&
      verifiedAt <= now() && now() - verifiedAt < verificationLifetime);
  }

  function recentlyRecovered(request) {
    const token = sessionToken(request);
    const recoveredAt = token ? sessions.get(token)?.recoveredAt : null;
    return Boolean(security?.mfaKey && Number.isSafeInteger(recoveredAt) &&
      recoveredAt <= now() && now() - recoveredAt < verificationLifetime);
  }

  function requireVerified(request, accounts) {
    const employee = requireActor(request, accounts);
    if (!employee.mfa) throw new AuthError(403, '请先在「我的账号」绑定两步验证');
    if (!recentlyVerified(request)) throw new AuthError(403, '请先在「我的账号」完成安全确认');
    return employee;
  }

  function requireVerifiedSuper(request, accounts, { required = false } = {}) {
    const employee = requireSuper(request, accounts);
    return security?.mfaKey && (required || employee.mfa || typeof security.mfaKey !== 'function')
      ? requireVerified(request, accounts) : employee;
  }

  function withAuthenticatorKey(use) {
    const derive = typeof security?.mfaKey === 'function';
    const key = derive ? security.mfaKey() : security?.mfaKey;
    try { return use(key); }
    finally { if (derive) key.fill(0); }
  }

  function shouldVerify(request) {
    return Boolean(security?.mfaKey &&
      (typeof security.mfaKey !== 'function' || actorRecord(request)?.mfa));
  }

  function report(action, employee, targetId = employee.id) {
    if (!onEvent) return;
    try {
      Promise.resolve(onEvent({ action, actor: publicEmployee(employee), targetId })).catch(
        () => {}
      );
    } catch {
      // The audit sink must not invalidate an established session or a committed account change.
    }
  }

  async function login(request, response) {
    const body = await parseJson(request);
    if (body.remember !== undefined && typeof body.remember !== 'boolean')
      throw new AuthError(400, '保持登录选项格式不正确');
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const address = checkNetwork(request, readAccounts(accountPath));
    throttle(response, 'password', email.slice(0, 254), address);
    if (validatingChallenge >= 8 || verifying >= 2) {
      protectionEvent('limited');
      monitor('limited', email);
      response.setHeader('Retry-After', '60');
      throw new AuthError(429, '登录尝试过于频繁，请稍后再试');
    }
    let challengeToken;
    if (security?.siteKey && typeof body.challenge === 'string' && body.challenge.length <= 2048 && body.challenge.length) {
      for (const [key, at] of challengeTokens) if (now() - at >= verificationLifetime) challengeTokens.delete(key);
      challengeToken = createHash('sha256').update(body.challenge).digest('hex');
      if (challengeTokens.has(challengeToken)) {
        protectionEvent('challenge');
        throw new AuthError(403, '请重新完成真人验证');
      }
      challengeTokens.set(challengeToken, now());
    }
    validatingChallenge++;
    let challenge;
    try {
      challenge = await verifyTurnstile(security, body.challenge, address, turnstileFetch);
    } finally {
      validatingChallenge--;
    }
    if (challenge !== 'passed') {
      if (challengeToken) challengeTokens.delete(challengeToken);
      if (challenge === 'unavailable') throw new AuthError(503, '真人验证暂时不可用，请稍后重试');
      protectionEvent('challenge');
      monitor('rejected', email);
      throw new AuthError(403, '请完成真人验证后重试');
    }
    if (email.length > 254 || password.length > 256 || Buffer.byteLength(password, 'utf8') > 512) {
      monitor('rejected', email);
      throw new AuthError(401, '邮箱或密码不正确');
    }
    if (verifying >= 2) throw new AuthError(429, '登录尝试过于频繁，请稍后再试');
    const previous = readAccounts(accountPath)?.employees.find((row) => row.email === email);
    verifying++;
    let matches;
    try {
      matches = await matchesCredential(password, previous?.credential || dummyCredential);
    } finally {
      verifying--;
    }
    const accounts = readAccounts(accountPath);
    checkNetwork(request, accounts);
    const employee = accounts?.employees.find((row) => row.id === previous?.id);
    if (!matches || !employee?.active || employee.sessionVersion !== previous.sessionVersion) {
      protectionEvent('credentials');
      monitor('rejected', email);
      throw new AuthError(401, '邮箱或密码不正确');
    }
    if (employee.mfa) {
      if (!security?.mfaKey) throw new AuthError(503, '两步验证暂时不可用，请联系管理员');
      const verification = newCheck(loginChecks, {
        employeeId: employee.id, version: employee.sessionVersion, address, remember: body.remember === true
      });
      return sendJson(response, 202, { verification, needsCode: true });
    }
    if (employee.deviceLock) throw new AuthError(403, '该账号的登录设备需由管理员核对');
    return finishLogin(request, response, employee, body.remember === true);
  }

  function finishLogin(request, response, employee, remember, verifiedMethod, recoveryCodes) {
    const at = now();
    removeBrowserSessions(request);
    if (publicUrl) {
      sessions.prune(at);
    } else {
      for (const [token, session] of sessions) {
        if (session.expiresAt <= at) sessions.delete(token);
      }
      if (sessions.size >= 1024) sessions.delete(sessions.keys().next().value);
    }
    const token = randomBytes(32).toString('hex');
    const createdAt = now();
    const lifetime = remember ? rememberedIdleLifetime : sessionLifetime;
    const deviceDigest = requestToken(request, browserCookie);
    sessions.set(createHash('sha256').update(token).digest('hex'), {
      id: randomUUID(), remembered: remember,
      createdAt, lastUsedAt: createdAt,
      absoluteExpiresAt: createdAt + (remember ? rememberedMaximumLifetime : sessionLifetime),
      device: browserName(request),
      employeeId: employee.id,
      version: employee.sessionVersion,
      expiresAt: createdAt + lifetime,
      ...(recoveryCodes && verifiedMethod === 'authenticator' ? { verifiedAt: createdAt } : {}),
      ...(verifiedMethod === 'recovery' ? { recoveredAt: createdAt } : {}),
      ...(deviceDigest ? { deviceDigest } : {})
    });
    // The server enforces rolling idle expiry; the browser cookie lasts only
    // until the absolute cap. Activity responses cannot overwrite a later login.
    setCookie(response, token, remember ? rememberedMaximumLifetime : lifetime, cookieName, Boolean(publicUrl));
    if (!recoveryCodes) report('auth_login', employee);
    sendJson(response, 200, { actor: publicEmployee(employee), ...(recoveryCodes ? { recoveryCodes } : {}) });
  }

  function mutate(request, change, authorize = requireSuper) {
    return changeAccounts(accountPath, accounts => {
      const operator = authorize(request, accounts);
      const employee = change(accounts.employees, operator, accounts);
      return { employee, operator };
    });
  }

  async function completeLogin(request, response) {
    const body = await parseJson(request);
    const check = typeof body.verification === 'string' && loginChecks.get(body.verification);
    if (!check || check.expiresAt <= now()) throw new AuthError(410, '登录验证已过期，请重新输入密码');
    const address = checkNetwork(request, readAccounts(accountPath));
    if (address !== check.address) throw new AuthError(410, '当前网络已变化，请重新输入密码');
    throttle(response, 'code', check.employeeId, address);
    const { employee, operator: result } = mutate(request, (employees) => {
      return employees.find(row => row.id === check.employeeId);
    }, (_request, accounts) => {
      checkNetwork(request, accounts);
      const row = accounts.employees.find(employee => employee.id === check.employeeId);
      if (!row?.active || row.sessionVersion !== check.version)
        throw new AuthError(410, '账号资料已变化，请重新输入密码');
      const method = withAuthenticatorKey(key => useAuthenticator(key, row, body.code, now(), { recovery: true }));
      if (!method) {
        protectionEvent('verification');
        monitor('rejected', row.email);
        throw new AuthError(400, '验证码无效或已使用，请输入新的验证码');
      }
      const digest = requestToken(request, browserCookie);
      if (!row.deviceLock || row.trustedDevices?.some(device => device.digest === digest && device.state === 'approved'))
        return { method };
      if (row.trustedDevices?.some(device => device.digest === digest && device.state === 'pending'))
        return { method, pending: true };
      const devices = (row.trustedDevices || []).filter(device =>
        device.state === 'approved' || device.at > now() - 7 * day);
      if (devices.length >= 12) return { method, pending: true };
      const browserToken = randomBytes(32).toString('hex');
      devices.push({ id: randomUUID(), digest: createHash('sha256').update(browserToken).digest('hex'),
        name: browserName(request), at: now(), state: 'pending' });
      row.trustedDevices = devices;
      return { method, pending: true, browserToken };
    });
    loginChecks.delete(body.verification);
    if (result.method === 'recovery') report('auth_recovery_used', employee);
    if (result.pending) {
      protectionEvent('device');
      if (result.browserToken) {
        appendCookie(response, browserCookie, result.browserToken, browserLifetime, Boolean(publicUrl));
        report('auth_device_requested', employee);
      }
      return sendJson(response, 202, { pendingDevice: true });
    }
    finishLogin(request, response, employee, check.remember, result.method);
  }

  function publicDevices(employee, request) {
    const digest = requestToken(request, browserCookie);
    return (employee.trustedDevices || []).map(row => ({
      id: row.id, name: row.name, at: row.at, state: row.state, current: row.digest === digest
    }));
  }

  async function updateSecurity(request, response, operation) {
    const body = await parseJson(request);
    const initial = requireActor(request);
    const address = verifiedAddress(request, security);
    throttle(response, 'security', initial.id, address);
    if (!security?.mfaKey) throw new AuthError(503, '两步验证尚未启用，请联系管理员');
    if (operation === 'start') {
      const password = typeof body.password === 'string' ? body.password : '';
      if (verifying >= 2) throw new AuthError(429, '尝试过于频繁，请等 1 分钟再试');
      let valid = false;
      verifying++;
      try {
        valid = Buffer.byteLength(password, 'utf8') <= 512 && await matchesCredential(password, initial.credential);
      } finally {
        verifying--;
      }
      if (!valid) throw new AuthError(400, '密码不正确');
      const employee = requireActor(request);
      if (employee.sessionVersion !== initial.sessionVersion) throw new AuthError(409, '账号资料已变化，请重试');
      if (employee.mfa && !recentlyVerified(request) && !recentlyRecovered(request))
        throw new AuthError(403, '更换验证器前请先完成安全确认');
      const { seed, setupKey, uri } = newAuthenticator(employee.email);
      const enrollment = newCheck(enrollmentChecks, {
        employeeId: employee.id, version: employee.sessionVersion, session: sessionToken(request), seed
      });
      return sendJson(response, 200, { enrollment, setupKey, uri });
    }
    if (operation === 'confirm') {
      const check = typeof body.enrollment === 'string' && enrollmentChecks.get(body.enrollment);
      if (!check || check.employeeId !== initial.id || check.version !== initial.sessionVersion ||
          check.session !== sessionToken(request) || check.expiresAt <= now())
        throw new AuthError(410, '绑定已过期，请重新开始');
      const replacing = Boolean(initial.mfa);
      const authorize = replacing && !recentlyRecovered(request) ? requireVerified : requireActor;
      const { employee: recoveryCodes, operator } = mutate(request, (_employees, employee) => {
        const codes = withAuthenticatorKey(key => bindAuthenticator(key, employee, check.seed, body.code, now()));
        if (!codes) throw new AuthError(400, '验证码不正确，请检查验证器中的账号和时间');
        employee.version++;
        employee.sessionVersion++;
        employee.updatedAt = new Date(now()).toISOString();
        return codes;
      }, authorize);
      enrollmentChecks.delete(body.enrollment);
      const remember = sessions.get(sessionToken(request))?.remembered === true;
      report(replacing ? 'auth_mfa_replace' : 'auth_mfa_bind', operator);
      finishLogin(request, response, operator, remember, 'authenticator', recoveryCodes);
      return;
    }
    if (operation === 'verify') {
      if (!initial.mfa) throw new AuthError(403, '请先绑定两步验证');
      if (recentlyVerified(request)) return sendJson(response, 200, { confirmed: true });
      const { employee } = mutate(request, (_employees, row) => {
        if (!withAuthenticatorKey(key => useAuthenticator(key, row, body.code, now())))
          throw new AuthError(400, '验证码无效或已使用，请输入新的验证码');
        return row;
      }, requireActor);
      if (!updateSession(sessionToken(request), row => ({ ...sessionMetadata(row), verifiedAt: now() })))
        throw new AuthError(401, '登录已失效，请重新登录');
      report('auth_step_up', employee);
      return sendJson(response, 200, { confirmed: true });
    }
  }

  async function updateTrustedDevice(request, response) {
    const body = await parseJson(request);
    const { employee: result, operator } = mutate(request, (employees, actor) => {
      const employee = body.employeeId && body.employeeId !== actor.id
        ? employees.find(row => row.id === body.employeeId && actor.role === 'super') : actor;
      if (!employee?.active) throw new AuthError(404, '未找到可管理的账号');
      const devices = employee.trustedDevices ||= [];
      const digest = requestToken(request, browserCookie);
      if (body.action === 'add-current' && employee.id === actor.id) {
        const current = devices.find(row => row.digest === digest);
        if (current?.state === 'approved') return { employee };
        if (devices.length >= 12) throw new AuthError(409, '请先移除一台旧设备');
        const token = randomBytes(32).toString('hex');
        const deviceDigest = createHash('sha256').update(token).digest('hex');
        devices.push({ id: randomUUID(), digest: deviceDigest, state: 'approved', name: browserName(request), at: now() });
        return { employee, token, deviceDigest };
      }
      if (body.action === 'set-lock' && typeof body.enabled === 'boolean') {
        if (body.enabled && (employee.id !== actor.id || !devices.some(row => row.digest === digest && row.state === 'approved')))
          throw new AuthError(400, '请由账号本人先信任当前设备');
        employee.deviceLock = body.enabled;
        return { employee };
      }
      const index = devices.findIndex(row => row.id === body.id);
      if (index < 0) throw new AuthError(404, '设备登记已变化，请刷新列表');
      if (body.action === 'approve') {
        if (devices[index].at <= now() - 7 * day && devices[index].state === 'pending')
          throw new AuthError(409, '设备申请已过期，请在新设备重新登录');
        devices[index].state = 'approved';
        return { employee };
      }
      if (body.action === 'remove') {
        if (employee.deviceLock && devices[index].state === 'approved' &&
            devices.filter(row => row.state === 'approved').length === 1)
          throw new AuthError(409, '启用设备限制时至少保留一台已批准设备');
        return { employee, removed: devices.splice(index, 1)[0] };
      }
      throw new AuthError(400, '请选择可用的设备操作');
    }, requireVerified);
    if (result.token) {
      if (!updateSession(sessionToken(request), row => ({ ...sessionMetadata(row), deviceDigest: result.deviceDigest })))
        throw new AuthError(401, '登录已失效，请重新登录');
      appendCookie(response, browserCookie, result.token, browserLifetime, Boolean(publicUrl));
    }
    if (result.removed) {
      for (const [digest, row] of sessions.entries())
        if (row.employeeId === result.employee.id && row.deviceDigest === result.removed.digest) sessions.delete(digest);
    }
    report('auth_device_policy', operator, result.employee.id);
    return sendJson(response, 200, { saved: true });
  }

  async function updateNetwork(request, response) {
    const body = await parseJson(request);
    if (!security?.mfaKey) throw new AuthError(503, '请先启用两步验证');
    const address = verifiedAddress(request, security);
    const { operator } = mutate(request, (_employees, actor, accounts) => {
      const policy = accounts.networkPolicy ||= { version: 0, mode: 'observe', entries: [] };
      if (policy.version !== body.version) throw new AuthError(409, '网络名单已变化，请刷新后重试');
      if (body.action === 'add') {
        const network = readNetwork(body.network);
        if (!network) throw new AuthError(400, '请填写有效的 IP 地址或公司网段');
        if (policy.entries.length >= 24 || policy.entries.some(row => row.network === network.value))
          throw new AuthError(409, '网络已登记或名单已满');
        policy.entries.push({ id: randomUUID(), name: validatedName(body.name), network: network.value });
      } else if (body.action === 'remove') {
        if (!policy.entries.some(row => row.id === body.id)) throw new AuthError(404, '该网络已移除');
        policy.entries = policy.entries.filter(row => row.id !== body.id);
      } else if (body.action === 'mode' && ['observe', 'enforce'].includes(body.mode)) {
        policy.mode = body.mode;
      } else throw new AuthError(400, '请选择可用的网络操作');
      if (policy.mode === 'enforce' && (!security?.host || !address || !allowsNetwork(policy, address)))
        throw new AuthError(409, '当前网络还不在名单中，请先登记并核对当前登录地址');
      policy.version++;
      return actor;
    }, (request, accounts) => requireVerifiedSuper(request, accounts, { required: true }));
    report('auth_network_policy', operator, '登录网络');
    return sendJson(response, 200, { saved: true });
  }

  async function createEmployee(request, response) {
    requireVerifiedSuper(request);
    const body = await parseJson(request);
    const email = validatedEmail(body.email);
    const name = validatedName(body.name);
    if (!employeeRoles.has(body.role)) throw new AuthError(400, '请选择可分配的员工角色');
    if (body.active !== undefined && typeof body.active !== 'boolean') {
      throw new AuthError(400, '员工状态格式不正确');
    }
    const credential = await createCredential(body.password);
    const { employee, operator } = mutate(request, (employees) => {
      if (employees.some((row) => row.email === email)) throw new AuthError(409, '员工邮箱已存在');
      const at = new Date(now()).toISOString();
      const row = {
        id: randomUUID(),
        email,
        name,
        role: body.role,
        active: body.active ?? true,
        credential,
        version: 1,
        sessionVersion: 1,
        createdAt: at,
        updatedAt: at
      };
      setTeamLead(employees, row, body.teamLeadId);
      employees.push(row);
      return row;
    }, requireVerifiedSuper);
    report('auth_employee_create', operator, employee.id);
    if (employee.role === 'admin' && employee.active) monitor('admin_access');
    sendJson(response, 201, { employee: publicEmployee(employee) });
  }

  async function updateEmployee(request, response, employeeId) {
    requireVerifiedSuper(request);
    const body = await parseJson(request);
    if (!Number.isSafeInteger(body.version) || body.version < 1) {
      throw new AuthError(400, '请选择最新的员工资料后保存');
    }
    if (body.role !== undefined && body.role !== 'super' && !employeeRoles.has(body.role)) {
      throw new AuthError(400, '请选择可分配的员工角色');
    }
    if (body.active !== undefined && typeof body.active !== 'boolean') {
      throw new AuthError(400, '员工状态格式不正确');
    }
    const nameValue = body.nickname === undefined ? body.name : body.nickname;
    const name = nameValue === undefined ? undefined : validatedName(nameValue);
    const credential =
      body.password === undefined ? undefined : await createCredential(body.password);
    let accessChanged = false;
    const { employee, operator } = mutate(request, (employees, actor) => {
      const row = employees.find((entry) => entry.id === employeeId);
      if (!row) throw new AuthError(404, '员工账号不存在');
      if (row.version !== body.version) throw new AuthError(409, '员工资料已更新，请刷新后再保存');
      const role = body.role ?? row.role;
      const active = body.active ?? row.active;
      if (
        (row.role === 'super' && (actor.id !== row.id || role !== 'super' || !active)) ||
        (role === 'super' && row.role !== 'super')
      ) {
        throw new AuthError(403, '超级管理员角色与启用状态受保护');
      }
      const previousRole = row.role;
      const previousTeamLead = row.teamLeadId;
      row.role = role;
      setTeamLead(employees, row, body.teamLeadId);
      accessChanged = Boolean(role !== previousRole ||
        active !== row.active || credential || previousTeamLead !== row.teamLeadId);
      if (accessChanged) row.sessionVersion++;
      if (body.nickname !== undefined || (name !== undefined && name !== row.name)) row.nicknameSet = true;
      row.name = name ?? row.name;
      row.active = active;
      row.credential = credential ?? row.credential;
      row.version++;
      row.updatedAt = new Date(now()).toISOString();
      return row;
    }, requireVerifiedSuper);
    report('auth_employee_update', operator, employee.id);
    if (accessChanged) monitor('admin_access');
    sendJson(response, 200, { employee: publicEmployee(employee) });
  }

  async function setOwnNickname(request, response) {
    requireActor(request);
    const body = await parseJson(request);
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'nickname'))
      throw new AuthError(400, '仅可设置自己的昵称');
    const nickname = validatedName(body.nickname);
    const { employee } = mutate(request, (_employees, actor) => {
      if (actor.nicknameSet === true) throw new AuthError(409, '昵称已设置，请联系管理员修改');
      actor.name = nickname;
      actor.nicknameSet = true;
      actor.version++;
      actor.updatedAt = new Date(now()).toISOString();
      return actor;
    }, requireActor);
    report('auth_nickname_set', employee);
    sendJson(response, 200, { actor: publicEmployee(employee) });
  }

  async function handle(request, response) {
    try {
      checkOrigin(request, publicUrl);
      const route = (request.url || '').split('?', 1)[0];
      const method = request.method;
      if (route === '/api/local/auth/session' && method === 'GET') {
        const actor = getActor(request);
        if (request.localAuthUnavailable) throw new Error('会话存储暂不可用');
        return sendJson(response, 200, { configured: true, actor, ...(!actor ? { reason: request.localAuthReason } : {}) });
      }
      if (route === '/api/local/auth/activity' && method === 'POST') {
        requireActor(request);
        const at = now();
        const digest = sessionToken(request);
        const session = updateSession(digest, current => {
          const row = sessionMetadata(current);
          if (row.expiresAt <= at) return undefined;
          return { ...row, lastUsedAt: at,
            expiresAt: row.remembered ? Math.min(at + rememberedIdleLifetime, row.absoluteExpiresAt) : row.expiresAt };
        });
        if (!session) throw new AuthError(401, '登录已过期，请重新登录');
        // Previously issued cookies retain rolling renewal under their old name.
        // A delayed legacy response cannot replace the authoritative v2 cookie.
        if (selectedCookie(request) === legacyCookieName && session.remembered)
          setCookie(response, requestCookie(request, legacyCookieName), session.expiresAt - at, legacyCookieName, Boolean(publicUrl));
        return sendJson(response, 200, { expiresAt: session.expiresAt, remembered: session.remembered });
      }
      if (route === '/api/local/auth/devices' && method === 'GET') {
        const employee = requireActor(request);
        const currentDigest = sessionToken(request);
        const items = [];
        for (const [digest, current] of sessions.entries()) {
          if (current.employeeId !== employee.id || current.version !== employee.sessionVersion || current.expiresAt <= now()) continue;
          const row = current.id ? current : updateSession(digest, sessionMetadata);
          if (!row) continue;
          items.push({ id: row.id, device: row.device, current: digest === currentDigest,
            remembered: row.remembered, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt,
            expiresAt: row.expiresAt, absoluteExpiresAt: row.absoluteExpiresAt });
        }
        items.sort((a, b) => Number(b.current) - Number(a.current) || b.lastUsedAt - a.lastUsedAt);
        return sendJson(response, 200, { items });
      }
      const deviceId = route.match(/^\/api\/local\/auth\/devices\/([0-9a-f-]{36})$/)?.[1];
      if (deviceId && method === 'DELETE') {
        const employee = requireActor(request);
        const currentDigest = sessionToken(request);
        let found = false, current = false;
        for (const [digest, row] of sessions.entries()) {
          if (row.employeeId !== employee.id || row.id !== deviceId) continue;
          sessions.delete(digest);
          current = digest === currentDigest;
          found = true;
        }
        if (!found) throw new AuthError(404, '该登录设备已退出，请刷新列表');
        if (current) {
          removeBrowserSessions(request);
          setCookie(response, '', 0, cookieName, Boolean(publicUrl), [legacyCookieName]);
        }
        report('auth_session_revoke', employee);
        return sendJson(response, 200, { current });
      }
      if (route === '/api/local/auth/login' && method === 'POST')
        return await login(request, response);
      if (route === '/api/local/auth/login/verify' && method === 'POST')
        return await completeLogin(request, response);
      if (route === '/api/local/auth/security' && method === 'GET') {
        const accounts = readAccounts(accountPath);
        const employee = requireActor(request, accounts);
        return sendJson(response, 200, { available: Boolean(security?.mfaKey), bound: Boolean(employee.mfa),
          recoveryRemaining: employee.mfa?.recovery.length ?? 0, recentlyVerified: recentlyVerified(request),
          canRebind: recentlyRecovered(request), requiredForExistingActions: shouldVerify(request),
          deviceLock: employee.deviceLock === true, devices: publicDevices(employee, request) });
      }
      const operation = route.match(/^\/api\/local\/auth\/security\/(start|confirm|verify)$/)?.[1];
      if (operation && method === 'POST') return await updateSecurity(request, response, operation);
      if (route === '/api/local/auth/security/device' && method === 'POST')
        return await updateTrustedDevice(request, response);
      if (route === '/api/local/auth/security/device-requests' && method === 'GET') {
        const accounts = readAccounts(accountPath);
        requireSuper(request, accounts);
        return sendJson(response, 200, { items: accounts.employees.filter(row => row.active)
          .flatMap(row => publicDevices(row, request).filter(device =>
            device.state === 'pending' && device.at > now() - 7 * day).map(device => ({
              id: device.id, name: device.name, at: device.at, employeeId: row.id, employeeName: row.name
            }))) });
      }
      if (route === '/api/local/auth/security/activity' && method === 'GET') {
        requireSuper(request);
        return sendJson(response, 200, { items: loginProtectionEvents.filter(row => now() - row.at < day)
          .slice(-10).reverse() });
      }
      if (route === '/api/local/auth/security/network') {
        if (method === 'GET') {
          const accounts = readAccounts(accountPath);
          requireSuper(request, accounts);
          const network = currentNetwork(request, accounts);
          return sendJson(response, 200, { policy: accounts.networkPolicy || { version: 0, mode: 'observe', entries: [] },
            connectable: Boolean(security?.host && security.proxyKey && network.address),
            address: network.address, challengeEnabled: Boolean(security?.siteKey),
            ...(accounts.lastSecurityRecovery && {
              lastRecovery: { at: accounts.lastSecurityRecovery.at, action: accounts.lastSecurityRecovery.action }
            }) });
        }
        if (method === 'POST') return await updateNetwork(request, response);
      }
      if (route === '/api/local/auth/logout' && method === 'POST') {
        const employee = actorRecord(request);
        removeBrowserSessions(request);
        setCookie(response, '', 0, cookieName, Boolean(publicUrl), [legacyCookieName]);
        if (employee) report('auth_logout', employee);
        return sendJson(response, 200, { actor: null });
      }
      if (route === '/api/local/auth/display-names' && method === 'GET') {
        const accounts = readAccounts(accountPath);
        const actor = requireActor(request, accounts);
        const teamOnly = actor.role === 'supervisor' || actor.role === 'registrar';
        const visible = teamOnly ? accounts.employees.filter(row =>
          row.id === actor.id || actor.role === 'supervisor' && row.teamLeadId === actor.id) : accounts.employees;
        return sendJson(response, 200, { items: visible.map(({ id, name }) => ({ id, name })) });
      }
      if (route === '/api/local/auth/order-owners' && method === 'GET') {
        const actor = requireActor(request);
        if (!['admin', 'super'].includes(actor.role))
          throw new AuthError(403, '只有管理员可以选择订单归属人');
        return sendJson(response, 200, { items: orderOwners().filter(row => ['admin', 'super', 'employee'].includes(row.role)) });
      }
      if (route === '/api/local/auth/nickname' && method === 'POST')
        return await setOwnNickname(request, response);
      if (route === '/api/local/auth/employees') {
        if (method === 'GET') {
          const accounts = readAccounts(accountPath);
          requireSuper(request, accounts);
          return sendJson(response, 200, { employees: accounts.employees.map(publicEmployee) });
        }
        if (method === 'POST') return await createEmployee(request, response);
      }
      const employeeId = route.match(/^\/api\/local\/auth\/employees\/([0-9a-f-]{36})$/)?.[1];
      if (employeeId && method === 'PATCH')
        return await updateEmployee(request, response, employeeId);
      sendJson(response, 404, { error: '没有这个本机员工接口' });
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      sendJson(response, error instanceof AuthError ? error.status : 500, {
        error: error instanceof AuthError ? error.message : '账户服务暂时无法处理请求，请稍后重试',
        ...(error instanceof AuthError && error.status === 401 ? { reason: request.localAuthReason || 'invalid' } : {})
      });
    }
  }

  return {
    getActor, orderOwners, handle, recentlyVerified, shouldVerify,
    teamFor(employeeId) {
      return readAccounts(accountPath).employees.filter(row => row.active && row.role === 'employee' && row.teamLeadId === employeeId)
        .map(({ id, name }) => ({ id, name }));
    },
    ready() {
      // Validate the account store and the existing session directory without
      // creating a session or reading a real user's token.
      const accounts = readAccounts(accountPath);
      if (!accounts || (accounts.employees.some(row => row.active && row.mfa) && !security?.mfaKey) ||
          (accounts.networkPolicy?.mode === 'enforce' && !security?.proxyKey)) return false;
      sessions.get('0'.repeat(64));
      return true;
    },
    changeVersion: () => createHash('sha256').update(JSON.stringify(
      readAccounts(accountPath).employees.map(({ id, version }) => [id, version]).sort(([a], [b]) => a.localeCompare(b))
    )).digest('hex')
  };
}
