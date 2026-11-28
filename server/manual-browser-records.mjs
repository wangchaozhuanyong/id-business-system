import { createHash, randomUUID } from 'node:crypto';
import { managesBusiness } from './access-roles.mjs';
import { ManualRenewalError } from './manual-renewal-records.mjs';

export const browserWindowsDomain = 'manual-browser-windows';
const preparedDomain = 'manual-browser-preparations';
const plans = new Set(['plus', 'pro100', 'pro200', 'pro500']);
const day = 86_400_000;

export function manualBrowserEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
    throw new ManualRenewalError(400, '请核对账号邮箱');
  return email;
}

export function manualRechargeWindowId(operatorId, email) {
  return 'recharge-' + createHash('sha256').update(JSON.stringify([operatorId, manualBrowserEmail(email)])).digest('hex');
}

export function requireManualPlan(plan) {
  if (!plans.has(plan)) throw new ManualRenewalError(400, '请选择有效的续费套餐');
  return plan;
}

export function manualBrowserNotes(notes) {
  if (typeof notes !== 'string' || notes.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(notes))
    throw new ManualRenewalError(400, '备注最多 2000 字，请核对内容');
  return notes.trim();
}

export function createManualBrowserRecords({ readDocument, putDocument, writeTransaction }) {
  function read(scope, actor) {
    if (!actor?.id || actor.active === false || !managesBusiness(actor)) throw new ManualRenewalError(403, '无权操作充值窗口');
    const domain = scope + ':' + actor.id;
    const { version, data } = readDocument(domain);
    return { domain, version, rows: data || [] };
  }
  function save(batch, rows) {
    putDocument(batch.domain, batch.version + 1, rows);
  }
  return {
    stageManualBrowser({ runId, email, plan, notes, routeBinding }, actor) {
      return writeTransaction(() => {
        email = manualBrowserEmail(email);
        const id = manualRechargeWindowId(actor.id, email);
        const existing = read(browserWindowsDomain, actor).rows.find(row => row.id === id);
        const batch = read(preparedDomain, actor);
        const now = Date.now();
        const recent = batch.rows.filter(row => now - row.at < day);
        recent.push({ id, runId, email, plan: requireManualPlan(plan), routeBinding,
          ...(notes !== undefined && { notes: manualBrowserNotes(notes) }),
          previousRevision: existing?.revision || null, sequence: batch.version + 1, at: now });
        save(batch, recent);
        return id;
      });
    },
    markManualBrowserConnected(id, runId, actor) {
      return writeTransaction(() => {
        const launches = read(preparedDomain, actor);
        const pending = launches.rows.find(row => row.id === id && row.runId === runId);
        const batch = read(browserWindowsDomain, actor);
        const existing = batch.rows.find(row => row.id === id);
        if (existing?.runId === runId || pending?.confirmed) return;
        if (!pending) throw new ManualRenewalError(409, '缺少本次窗口的准备记录');
        // Preserve a remark edited, or a record removed, while the viewer was connecting.
        if ((existing || !pending.previousRevision) && !(existing?.sequence > pending.sequence)) {
          const retainNotes = existing && (pending.notes === undefined || existing.revision !== pending.previousRevision);
          const record = { id, runId, sequence: pending.sequence, email: pending.email, plan: pending.plan,
            routeBinding: pending.routeBinding,
            notes: retainNotes ? existing.notes : pending.notes || '',
            lastOpenedAt: new Date().toISOString(), revision: randomUUID() };
          save(batch, [...batch.rows.filter(row => row.id !== id), record]);
        }
        pending.confirmed = true;
        delete pending.notes;
        save(launches, launches.rows);
      });
    },
    manualBrowserOwnerEmail(id, runId, actor) {
      return read(preparedDomain, actor).rows.find(row => row.id === id && row.runId === runId)?.email ||
        read(browserWindowsDomain, actor).rows.find(row => row.id === id && row.runId === runId)?.email || null;
    },
    manualBrowserRouteBinding(id, runId, actor) {
      const match = row => row.id === id && row.runId === runId;
      const binding = read(preparedDomain, actor).rows.find(match)?.routeBinding ||
        read(browserWindowsDomain, actor).rows.find(match)?.routeBinding;
      if (!binding) throw new ManualRenewalError(409, '原窗口缺少有效的线路记录，请回工作台重新测速');
      return binding;
    },
    listManualBrowserWindows(query, actor) {
      const pageSize = Number(query.get('pageSize') || 20);
      const requested = Number(query.get('page') || 1);
      const search = (query.get('search') || '').trim().toLowerCase();
      if (![10, 20, 50].includes(pageSize) || !Number.isSafeInteger(requested) || requested < 1 || search.length > 320)
        throw new ManualRenewalError(400, '请核对分页与搜索条件');
      const batch = read(browserWindowsDomain, actor);
      const matches = batch.rows.filter(row => [row.email, row.notes].some(value => value.toLowerCase().includes(search)))
        .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt) || a.id.localeCompare(b.id));
      const total = matches.length;
      const page = Math.min(requested, Math.max(1, Math.ceil(total / pageSize)));
      const items = matches.slice((page - 1) * pageSize, page * pageSize)
        .map(({ id, email, plan, notes, lastOpenedAt, revision }) => ({ id, email, plan, notes, lastOpenedAt, revision }));
      return { items, total, page, pageSize, version: batch.version };
    },
    changeManualBrowserWindow({ id, revision, notes }, actor, remove = false) {
      return writeTransaction(() => {
        const batch = read(browserWindowsDomain, actor);
        const row = batch.rows.find(item => item.id === id);
        if (!row) throw new ManualRenewalError(404, '窗口记录不存在');
        if (row.revision !== revision) throw new ManualRenewalError(409, '记录已更新，请刷新核对后重试');
        if (remove) {
          save(batch, batch.rows.filter(item => item.id !== id));
          const launches = read(preparedDomain, actor);
          for (const launch of launches.rows.filter(entry => entry.id === id && !entry.confirmed)) {
            launch.confirmed = true;
            delete launch.notes;
          }
          save(launches, launches.rows);
        } else {
          const clean = manualBrowserNotes(notes);
          if (row.notes !== clean) {
            row.notes = clean;
            row.revision = randomUUID();
            save(batch, batch.rows);
          }
        }
        return { ok: true };
      });
    },
  };
}
