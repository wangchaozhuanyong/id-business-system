import { createHash, randomUUID } from 'node:crypto';

const statuses = ['pending_renewal', 'active', 'expired'];
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const editable = ['status', 'currentPlan', 'renewalNotes'];
const proxyLabels = new Map([['auto', '智能选路'], ['PH', '菲律宾'], ['EG', '埃及'], ['direct', '直连']]);
const cleanText = value => typeof value === 'string' ? value.trim() : '';

export class ManualRenewalError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function fields(row) {
  return {
    status: statuses.includes(row.status) ? row.status : 'unknown',
    currentPlan: cleanText(row.currentPlan).toLowerCase(),
    renewalNotes: cleanText(row.renewalNotes)
  };
}

// The legacy document is read-only here. Project display metadata before merging manual entries.
export function manualRenewalRecords(legacy, registry) {
  const registered = new Map(registry.map(row => [row.id, row]));
  const rows = new Map();
  const register = (row, overlay) => {
    const email = cleanText(row.email).toLowerCase();
    if (!email || !row.id) return;
    const values = overlay?.status ? fields(overlay) : fields(row);
    const updatedAt = [row.updatedAt, overlay?.updatedAt].filter(Boolean).sort().at(-1) || '';
    const lastOpenedAt = [row.lastOpenedAt, overlay?.lastOpenedAt].filter(Boolean).sort().at(-1) || null;
    const snapshot = [row.id, email, overlay?.editVersion || row.editVersion || 0, ...Object.values(values)];
    const revision = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    rows.set(email, { id: row.id, email, ...values, proxySummary: proxyLabels.get(row.proxyRegion) || '', lastOpenedAt, updatedAt, revision });
  };
  for (const row of legacy) register(row, registered.get(row.id));
  for (const row of registry) if (row.origin === 'manual') register(row);
  return [...rows.values()];
}

export function listRenewalPage(rows, query) {
  const requested = Number(query.get('page') || 1);
  const pageSize = Number(query.get('pageSize') || 20);
  const keyword = (query.get('search') || '').trim().toLowerCase();
  const status = query.get('status') || '';
  if (!Number.isSafeInteger(requested) || requested < 1 || ![10, 20, 50].includes(pageSize) ||
      keyword.length > 320 || (status && status !== 'unknown' && !statuses.includes(status))) {
    throw new ManualRenewalError(400, '请核对分页和续费筛选条件');
  }
  const counts = { pending_renewal: 0, active: 0, expired: 0, unknown: 0 };
  const plans = new Map();
  const matches = [];
  for (const row of rows) {
    counts[row.status]++;
    plans.set(row.currentPlan, (plans.get(row.currentPlan) || 0) + 1);
    if ((!status || row.status === status) &&
        [row.email, row.proxySummary, row.renewalNotes].some(value => value.toLowerCase().includes(keyword)))
      matches.push(row);
  }
  matches.sort((a, b) => (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || '') ||
    b.updatedAt.localeCompare(a.updatedAt) || a.email.localeCompare(b.email));
  const total = matches.length;
  const page = Math.min(requested, Math.max(1, Math.ceil(total / pageSize)));
  return { page, pageSize, total, items: matches.slice((page - 1) * pageSize, page * pageSize),
    summary: { total: rows.length, statuses: counts, plans: [...plans].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) } };
}

export function requireRenewalRecord(rows, id) {
  const row = rows.find(item => item.id === id);
  if (!row) throw new ManualRenewalError(404, '续费登记不存在');
  return row;
}

export function editRenewalRecord(rows, registry, command, now) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw new ManualRenewalError(400, '登记格式无效');
  const editing = Object.hasOwn(command, 'id');
  const retainUnregistered = editing && command.status === 'unknown';
  const allowed = [...editable, ...(editing ? ['id', 'expectedRevision'] : ['email'])];
  if (Object.keys(command).some(key => !allowed.includes(key)) ||
      !(statuses.includes(command.status) || retainUnregistered) || typeof command.currentPlan !== 'string' ||
      !/^[\p{L}\p{N} _+.()-]{0,48}$/u.test(command.currentPlan) ||
      typeof command.renewalNotes !== 'string' || command.renewalNotes.length > 2000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(command.renewalNotes)) {
    throw new ManualRenewalError(400, '请核对续费状态、套餐和备注');
  }
  const values = fields(command);
  if (editing && (typeof command.id !== 'string' || !/^[a-f0-9]{64}$/.test(command.expectedRevision || '')))
    throw new ManualRenewalError(400, '缺少有效的记录版本，请刷新后重试');
  let row;
  const email = cleanText(command.email).toLowerCase();
  if (editing) row = requireRenewalRecord(rows, command.id);
  else {
    if (email.length > 254 || !emailPattern.test(email)) throw new ManualRenewalError(400, '请填写有效的账号邮箱');
    row = rows.find(item => item.email === email);
  }
  const entry = row && registry.find(item => item.id === row.id);
  if (row && editable.every(key => row[key] === values[key]) && (editing || entry?.origin === 'manual'))
    return { id: row.id, unchanged: true };
  if (row && !editing) throw new ManualRenewalError(409, '该邮箱已有续费登记，请编辑已有记录');
  if (editing && command.expectedRevision !== row.revision) throw new ManualRenewalError(409, '记录已修改，请刷新后核对');
  if (retainUnregistered && row.status !== 'unknown') throw new ManualRenewalError(400, '请选择续费状态');
  return {
    ...(entry || { id: row?.id || randomUUID(), origin: row ? 'legacy' : 'manual' }),
    ...(!editing ? { email } : {}),
    ...values, editVersion: (entry?.editVersion || 0) + 1, updatedAt: now
  };
}
