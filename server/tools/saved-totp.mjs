import { randomUUID } from 'node:crypto';

import { calculateTotp } from '../../modules/tools/totp.mjs';

export const savedTotpDomain = 'saved-totp';
export class SavedTotpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function issuerOf(secret) {
  try {
    const url = new URL(secret);
    if (url.protocol === 'otpauth:') return (url.searchParams.get('issuer') || '').trim().slice(0, 80);
  } catch {
    // Existing Base32 records do not have an issuer.
  }
  return '';
}

export function savedTotpMetadata(snapshot) {
  return {
    version: snapshot.version,
    items: (snapshot.data || []).map(({ id, name, updatedAt, secret }) => ({ id, name, updatedAt, issuer: issuerOf(secret) }))
  };
}

export function revealSavedTotpSecret(body, actor, { readSnapshot, recordView }) {
  if (!actor?.id) throw new SavedTotpError(401, '请先登录');
  if (!/^[a-f\d-]{36}$/.test(body?.id || '') ||
      !Number.isSafeInteger(body?.version) || body.version < 0)
    throw new SavedTotpError(400, '账号操作格式无效');
  const snapshot = readSnapshot(`${savedTotpDomain}:${actor.id}`);
  if (snapshot.version !== body.version)
    throw new SavedTotpError(409, '账号列表已更新，请重新读取后核对');
  const account = (snapshot.data || []).find(row => row.id === body.id);
  if (!account) throw new SavedTotpError(404, '找不到已保存的账号');
  recordView(account.id, snapshot.version);
  return { id: account.id, version: snapshot.version, secret: account.secret };
}

export async function validateTotpWrite(body) {
  if (!body || !['create', 'update', 'delete'].includes(body.action) ||
      !Number.isSafeInteger(body.version) || body.version < 0 ||
      (body.action !== 'create' && !/^[a-f\d-]{36}$/.test(body.id || '')))
    throw new SavedTotpError(400, '账号操作格式无效');
  const { action, version, id } = body;
  if (action === 'delete') return { action, version, id };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const secret = typeof body.secret === 'string' ? body.secret.trim() : '';
  if (!name || name.length > 80 || /[\p{C}]/u.test(name))
    throw new SavedTotpError(400, '请输入 1 至 80 字的账号名称');
  if (body.secret !== undefined && typeof body.secret !== 'string')
    throw new SavedTotpError(400, '验证器密钥格式无效');
  if (secret) {
    if (secret.length > 2048 || /[\r\n|]/.test(secret))
      throw new SavedTotpError(400, '请输入单个 Base32 密钥或验证器链接');
    try {
      await calculateTotp(secret);
    } catch (error) {
      throw new SavedTotpError(400, error.message);
    }
  } else if (action === 'create') {
    throw new SavedTotpError(400, '请输入验证器密钥');
  }
  return { action, version, id, name, secret };
}

export function applyTotpWrite(snapshot, command, now) {
  if (snapshot.version !== command.version)
    throw new SavedTotpError(409, '账号列表已更新，请重新读取后核对');
  const items = snapshot.data || [];
  const index = items.findIndex((item) => item.id === command.id);
  if (command.action !== 'create' && index < 0)
    throw new SavedTotpError(404, '找不到已保存的账号');
  if (command.action === 'delete') return {
    id: command.id, items: items.filter((item) => item.id !== command.id)
  };
  if (command.action === 'create') {
    if (items.length >= 100) throw new SavedTotpError(400, '已保存账号达到 100 项');
    const id = randomUUID();
    return { id, items: [...items, { id, name: command.name, secret: command.secret, updatedAt: now }] };
  }
  const item = { ...items[index], name: command.name, updatedAt: now };
  if (command.secret) item.secret = command.secret;
  return { id: item.id, items: items.map((row, i) => i === index ? item : row) };
}

export async function generateSavedCode(snapshot, id) {
  const account = (snapshot.data || []).find((row) => row.id === id);
  if (!account) throw new SavedTotpError(404, '找不到已保存的账号');
  const now = Date.now();
  const code = await calculateTotp(account.secret, now);
  return { ...code, serverNow: now };
}
