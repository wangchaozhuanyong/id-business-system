import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
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

export const localAdminEmail = 'ppfzj1314@gmail.com';
const cookieName = 'id_local_session';
const sessionLifetime = 8 * 60 * 60 * 1000;
const loginWindow = 60_000;
const accountAttempts = 8;
const totalAttempts = 32;
const employeeRoles = new Set(['admin', 'employee']);
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

function publicEmployee({ id, email, name, role, active, version, createdAt, updatedAt }) {
  return { id, email, name, role, active, version, createdAt, updatedAt };
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
        typeof employee.active !== 'boolean' ||
        !Number.isSafeInteger(employee.version) ||
        employee.version < 1 ||
        !Number.isSafeInteger(employee.sessionVersion) ||
        employee.sessionVersion < 1 ||
        (employee.role !== 'super' && !employeeRoles.has(employee.role)) ||
        !/^[0-9a-f]{48}$/.test(employee.credential?.salt) ||
        !/^[0-9a-f]{128}$/.test(employee.credential?.hash)
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

function requestToken(request) {
  const cookies = String(request.headers.cookie || '').split(';');
  const matches = cookies
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.startsWith(cookieName + '='));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(cookieName.length + 1);
  return tokenPattern.test(token) ? createHash('sha256').update(token).digest('hex') : null;
}

function setCookie(response, token, lifetime) {
  response.setHeader(
    'Set-Cookie',
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(lifetime / 1000)}`
  );
}

function checkOrigin(request) {
  const host = request.headers.host || '';
  const expectedOrigin = 'http://' + host;
  const fetchSite = request.headers['sec-fetch-site'];
  if (
    !/^(?:127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(host) ||
    (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') ||
    (request.headers.origin && request.headers.origin !== expectedOrigin) ||
    (request.method !== 'GET' && request.headers.origin !== expectedOrigin)
  ) {
    throw new AuthError(403, '仅可通过本机业务页面访问员工账户');
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

export function createLocalAuth(accountPath, { onEvent, now = Date.now } = {}) {
  if (!readAccounts(accountPath)) return null;
  const sessions = new Map();
  const attempts = [];
  let verifying = 0;

  function actorRecord(request, accounts) {
    const token = requestToken(request);
    const session = sessions.get(token);
    if (!session) return null;
    const current = accounts === undefined ? readAccounts(accountPath) : accounts;
    const employee = current?.employees.find((row) => row.id === session.employeeId);
    if (
      session.expiresAt <= now() ||
      !employee?.active ||
      employee.sessionVersion !== session.version
    ) {
      sessions.delete(token);
      return null;
    }
    return employee;
  }

  function getActor(request) {
    try {
      const employee = actorRecord(request);
      return employee ? publicEmployee(employee) : null;
    } catch {
      return null;
    }
  }

  function requireSuper(request, accounts) {
    const employee = actorRecord(request, accounts);
    if (!employee) throw new AuthError(401, '请先登录本机业务系统');
    if (employee.role !== 'super') throw new AuthError(403, '仅超级管理员可管理员工账户');
    return employee;
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
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const at = now();
    while (attempts.length && attempts[0].at <= at - loginWindow) attempts.shift();
    if (
      attempts.length >= totalAttempts ||
      attempts.filter((attempt) => attempt.email === email).length >= accountAttempts ||
      verifying >= 2
    ) {
      response.setHeader('Retry-After', '60');
      throw new AuthError(429, '登录尝试过于频繁，请稍后再试');
    }
    attempts.push({ email: email.slice(0, 254), at });
    if (email.length > 254 || password.length > 256 || Buffer.byteLength(password, 'utf8') > 512) {
      throw new AuthError(401, '邮箱或密码不正确');
    }
    const previous = readAccounts(accountPath)?.employees.find((row) => row.email === email);
    verifying++;
    let matches;
    try {
      matches = await matchesCredential(password, previous?.credential || dummyCredential);
    } finally {
      verifying--;
    }
    const employee = readAccounts(accountPath)?.employees.find((row) => row.id === previous?.id);
    if (!matches || !employee?.active || employee.sessionVersion !== previous.sessionVersion) {
      throw new AuthError(401, '邮箱或密码不正确');
    }
    const previousToken = requestToken(request);
    if (previousToken) sessions.delete(previousToken);
    for (const [token, session] of sessions) {
      if (session.expiresAt <= at) sessions.delete(token);
    }
    if (sessions.size >= 1024) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('hex');
    sessions.set(createHash('sha256').update(token).digest('hex'), {
      employeeId: employee.id,
      version: employee.sessionVersion,
      expiresAt: now() + sessionLifetime
    });
    setCookie(response, token, sessionLifetime);
    report('auth_login', employee);
    sendJson(response, 200, { actor: publicEmployee(employee) });
  }

  function mutate(request, change) {
    const lockPath = accountPath + '.lock';
    let lock;
    try {
      lock = openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') throw new AuthError(409, '员工资料正在保存，请稍后重试');
      throw error;
    }
    try {
      const accounts = readAccounts(accountPath);
      const supervisor = requireSuper(request, accounts);
      const employee = change(accounts.employees, supervisor);
      writeAccounts(accountPath, accounts);
      return { employee, supervisor };
    } finally {
      closeSync(lock);
      unlinkSync(lockPath);
    }
  }

  async function createEmployee(request, response) {
    requireSuper(request);
    const body = await parseJson(request);
    const email = validatedEmail(body.email);
    const name = validatedName(body.name);
    if (!employeeRoles.has(body.role)) throw new AuthError(400, '请选择可分配的员工角色');
    if (body.active !== undefined && typeof body.active !== 'boolean') {
      throw new AuthError(400, '员工状态格式不正确');
    }
    const credential = await createCredential(body.password);
    const { employee, supervisor } = mutate(request, (employees) => {
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
      employees.push(row);
      return row;
    });
    report('auth_employee_create', supervisor, employee.id);
    sendJson(response, 201, { employee: publicEmployee(employee) });
  }

  async function updateEmployee(request, response, employeeId) {
    requireSuper(request);
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
    const name = body.name === undefined ? undefined : validatedName(body.name);
    const credential =
      body.password === undefined ? undefined : await createCredential(body.password);
    const { employee, supervisor } = mutate(request, (employees, actor) => {
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
      if (role !== row.role || active !== row.active || credential) row.sessionVersion++;
      row.name = name ?? row.name;
      row.role = role;
      row.active = active;
      row.credential = credential ?? row.credential;
      row.version++;
      row.updatedAt = new Date(now()).toISOString();
      return row;
    });
    report('auth_employee_update', supervisor, employee.id);
    sendJson(response, 200, { employee: publicEmployee(employee) });
  }

  async function handle(request, response) {
    try {
      checkOrigin(request);
      const route = (request.url || '').split('?', 1)[0];
      const method = request.method;
      if (route === '/api/local/auth/session' && method === 'GET') {
        return sendJson(response, 200, { configured: true, actor: getActor(request) });
      }
      if (route === '/api/local/auth/login' && method === 'POST')
        return await login(request, response);
      if (route === '/api/local/auth/logout' && method === 'POST') {
        const employee = actorRecord(request);
        sessions.delete(requestToken(request));
        setCookie(response, '', 0);
        if (employee) report('auth_logout', employee);
        return sendJson(response, 200, { actor: null });
      }
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
        error: error instanceof AuthError ? error.message : '本机员工服务暂时无法处理请求'
      });
    }
  }

  return { getActor, handle };
}
