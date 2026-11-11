import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseV2DateTimeInput, toV2DateTimeInput } from '../modules/time/dateTime.ts';
import { registrationOccupancy, registrationProductConflict } from './inventory-registration.mjs';

const phases = new Map([['已开通', 'opened'], ['养号中', 'aging'], ['死号', 'dead']]);
const plans = new Set(['Pro', 'Max 5x', 'Max 20x']);
const fields = ['email', 'state', 'registered', 'plan', 'start', 'expiry', 'country', 'device', 'note'];
const emailKey = value => String(value ?? '').trim().toLowerCase();

export class ClaudeHistoryIntakeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function historyDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?$/.test(value)) return null;
  const date = value.replace(' ', 'T');
  const local = date.length === 10 ? date + 'T00:00' : date;
  const instant = parseV2DateTimeInput(local)?.getTime();
  return Number.isFinite(instant) ? { date, instant } : null;
}

export function planClaudeHistoryIntake(input, inventory, commerce, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['rows', 'inventoryVersion'].includes(key)) ||
      !Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 100)
    throw new ClaudeHistoryIntakeError('请按表头填写 1 至 100 条 Claude 历史账号');

  const accounts = Map.groupBy((inventory.data?.accounts || []).filter(row => row?.type === 'claude'),
    row => emailKey(row.email));
  const registeredEmails = registrationOccupancy(inventory.data);
  const sold = new Set((commerce.data?.orders || []).filter(row =>
    ['Claude Pro', 'Claude Max'].includes(row?.product) && (row.accountId || row.customerId))
    .map(row => emailKey(row.email)));
  const seen = new Set();
  const rows = input.rows.map((raw, index) => {
    const line = index + 1;
    const problem = error => ({ line, error });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        Object.entries(raw).some(([key, value]) =>
          !fields.includes(key) || typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)))
      return problem('请只填写历史入库表头中的文字字段');

    const values = Object.fromEntries(fields.map(key => [key, raw[key]?.trim() || '']));
    const email = emailKey(values.email);
    if (email.length > 254 || !/^[^\s@,|]+@[^\s@,|]+\.[^\s@,|]+$/.test(email))
      return problem('请输入有效的 Claude 登录邮箱');
    if (seen.has(email)) return problem('同一批 Claude 登录邮箱重复');
    seen.add(email);
    const phase = phases.get(values.state);
    if (!phase) return problem('请选择已开通、养号中或死号');
    if (values.country.length > 100 || values.device.length > 200 || values.note.length > 500)
      return problem('国家地区、登录设备或来源备注过长');

    const registered = historyDate(values.registered);
    if (values.registered && (!registered || registered.instant > now))
      return problem('请核对原注册时间');
    const hasPeriod = Boolean(values.plan || values.start || values.expiry);
    const start = historyDate(values.start);
    const expiry = historyDate(values.expiry);
    if (phase === 'aging' && hasPeriod) return problem('养号中的账号请保留未开通状态');
    if ((phase === 'opened' || hasPeriod) && (!plans.has(values.plan) || !start || !expiry ||
        start.instant > now || expiry.instant <= start.instant ||
        (registered && (registered.date.length === 10 || start.date.length === 10
          ? registered.date.slice(0, 10) > start.date.slice(0, 10) : registered.instant > start.instant))))
      return problem('请核对原套餐、开通时间和到期时间');

    const details = { country: values.country, device: values.device, registered: registered?.date || '', notes: values.note };
    const history = { phase, plan: values.plan, start: start?.date || '', expiry: expiry?.date || '' };
    const health = phase === 'dead' ? 'dead' : 'normal';
    const [prior, duplicate] = accounts.get(email) || [];
    const conflict = registrationProductConflict(registeredEmails.get(email), 'claude', prior?.id);
    if (conflict) return problem(conflict);
    if (prior && (duplicate || !isDeepStrictEqual(prior.claudeHistory, history) || prior.health !== health ||
        Object.entries(details).some(([key, value]) => (prior[key] || '') !== value)))
      return problem('已有同邮箱的 Claude 账号，请核对原记录');
    if (!prior && sold.has(email)) return problem('该邮箱已关联客户订单，请先核对账号归属');

    return { line, email, state: values.state, health, details, history, prior };
  });
  return { inventoryVersion: inventory.version, rows, additions: rows.filter(row => !row.error && !row.prior) };
}

export function claudeHistoryPreview(plan) {
  return {
    inventoryVersion: plan.inventoryVersion,
    pending: plan.additions.length,
    rows: plan.rows.map(row => row.error ? { line: row.line, error: row.error } : {
      line: row.line, email: row.email, state: row.state, plan: row.history.plan, registered: row.details.registered,
      start: row.history.start, expiry: row.history.expiry, result: row.prior ? '已登记' : '待入库'
    })
  };
}

export function stageClaudeHistoryIntake(plan, inventoryVersion, inventory, actor, time) {
  if (inventoryVersion !== plan.inventoryVersion)
    throw new ClaudeHistoryIntakeError('库存已变化，请重新预检', 409);
  const problem = plan.rows.find(row => row.error);
  if (problem) throw new ClaudeHistoryIntakeError('第 ' + problem.line + ' 条。' + problem.error, 409);
  const imported = plan.additions.length;
  const reused = plan.rows.length - imported;
  if (!imported) return { imported, reused };

  const batchId = 'claude-history-' + randomUUID();
  const recordedAt = toV2DateTimeInput(time).replace('T', ' ');
  const attribution = { actorId: actor.id, actor: actor.name, time: recordedAt };
  const results = [];
  const accounts = plan.additions.map(row => {
    const id = 'claude-' + randomUUID();
    const used = row.history.phase === 'opened';
    results.push({
      id: 'row-' + row.line, assetId: id, line: row.line, email: row.email, type: 'claude',
      registered: row.details.registered, createdAt: recordedAt, result: row.state
    });
    return {
      id, type: 'claude', email: row.email, emailType: /@(?:gmail|googlemail)\.com$/.test(row.email) ? 'google' : '',
      ...row.details, claudeHistory: row.history, source: '历史入库',
      status: '冻结', health: row.health, inventoryState: used ? 'used' : 'available', used,
      ...(used && { actualUsedAt: row.history.start.replace('T', ' ') }), usageLinks: [],
      importId: batchId, importedAt: recordedAt, createdAt: recordedAt, createdById: actor.id, createdBy: actor.name,
      lastOperatedAt: recordedAt, lastOperatedById: actor.id, lastOperatedBy: actor.name, version: 1,
      inventoryHistory: [{ id: randomUUID(), action: 'Claude 历史入库', detail: row.state, ...attribution }]
    };
  });
  (inventory.accounts ??= []).unshift(...accounts);
  (inventory.importRecords ??= []).unshift({
    id: batchId, type: 'claude', types: ['claude'], total: imported, success: imported, failed: 0,
    status: '已导入', results, ...attribution
  });
  return { imported, reused, batchId };
}
