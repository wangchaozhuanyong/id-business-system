import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const policyKey = 'paya/policy';
const active = 'paya/open/';
const audit = 'paya/audit/';
export const approvalLifetime = 120_000;
export const waitingLabel = '等待商家确认付款，请勿重复提交';
export const endedLabel = '本次执行已在付款提交前结束';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const job = /^\d{13}-[a-z0-9]{12}$/;
const plans = new Set(['plus', 'pro100', 'pro200', 'pro500', 'pro_5x', 'pro_20x', 'pro_50x']);
const defaultPolicy = { automatic: false, version: 0 };
function conflict() { return Object.assign(new Error('状态已变化或已过期，请刷新后核对。'), { status: 409 }); }

async function read(db, key, lock = false) {
  const [rows] = await db.execute('SELECT config_value FROM app_config WHERE config_key = ?' +
    (lock ? ' FOR UPDATE' : ''), [key]);
  return rows.length ? JSON.parse(rows[0].config_value) : null;
}

async function insert(db, key, value) {
  await db.execute('INSERT INTO app_config (config_key, config_value) VALUES (?, ?)', [key, JSON.stringify(value)]);
}

async function update(db, key, value, destination = key) {
  const [result] = await db.execute('UPDATE app_config SET config_key = ?, config_value = ? WHERE config_key = ?',
    [destination, JSON.stringify(value), key]);
  if (result.affectedRows !== 1) throw conflict();
}

function checkedPolicy(value) {
  if (!value) return defaultPolicy;
  if (typeof value.automatic !== 'boolean' || !Number.isSafeInteger(value.version) || value.version < 1)
    throw new Error('付款模式暂不可核实');
  return value;
}

export function createPaymentApprovals(transaction, now = Date.now) {
  const policy = () => transaction(async db => checkedPolicy(await read(db, policyKey)));
  async function setPolicy(automatic, version, actor) {
    if (typeof automatic !== 'boolean' || !Number.isSafeInteger(version) || version < 0 || !actor) throw conflict();
    return transaction(async db => {
      const old = checkedPolicy(await read(db, policyKey, true));
      if (version !== old.version) throw conflict();
      if (automatic === old.automatic) return old;
      const next = { automatic, version: version + 1, actor, at: now() };
      await insert(db, 'paya/mode/' + next.version, next);
      if (version === 0) await insert(db, policyKey, next);
      else await update(db, policyKey, next);
      return next;
    });
  }
  async function automaticAllowed(admissionVersion) {
    if (!Number.isSafeInteger(admissionVersion) || admissionVersion <= 0) return false;
    return transaction(async db => {
      const mode = checkedPolicy(await read(db, policyKey, true));
      return mode.automatic && mode.version === admissionVersion;
    });
  }
  async function open(jobKey, plan, quote, deadline) {
    if (!job.test(jobKey) || !plans.has(plan) || !quote) throw conflict();
    return transaction(async db => {
      const id = randomUUID(), expires = Math.min(now() + approvalLifetime, deadline);
      if (!Number.isFinite(expires) || expires <= now()) throw conflict();
      const row = { id, jobKey, plan, ...quote, state: 'pending', expires };
      const [result] = await db.execute("UPDATE task_logs SET message = ? WHERE job_key = ? AND status = 'running'",
        [waitingLabel + ' [' + id + ':' + expires + ']', jobKey]);
      if (result.affectedRows !== 1) throw conflict();
      await insert(db, active + id, row);
      return row;
    });
  }
  const get = id => transaction(db => read(db, active + id));
  async function decide(id, decision, actor) {
    if (!uuid.test(id) || !['approved', 'cancelled'].includes(decision) || !actor) throw conflict();
    return transaction(async db => {
      const row = await read(db, active + id, true);
      if (!row || row.expires <= now() || row.state !== 'pending') throw conflict();
      const [jobs] = await db.execute("SELECT job_key FROM task_logs WHERE job_key = ? AND status = 'running' FOR UPDATE", [row.jobKey]);
      if (!jobs.length) throw conflict();
      await update(db, active + id, { ...row, state: decision, actor, decidedAt: now() });
    });
  }
  async function finish(id, state, quote, card) {
    return transaction(async db => {
      const row = await read(db, active + id, true);
      if (!row) throw conflict();
      if (state === 'consumed' && (row.state !== 'approved' || row.expires <= now() ||
          row.amount !== quote?.amount || row.currency !== quote?.currency)) throw conflict();
      if (state === 'consumed') {
        if (!await cardOwnedByAttempt(db, card, true) || row.expires <= now()) throw conflict();
      }
      await update(db, active + id, { ...row, decision: row.state, state, finishedAt: now() }, audit + id);
    });
  }
  async function list() {
    return transaction(async db => {
      const [rows] = await db.execute(
        "SELECT c.config_value, t.token_preview, RIGHT(t.cdk_code,4) AS tail FROM app_config c " +
        "JOIN task_logs t ON t.job_key = JSON_UNQUOTE(JSON_EXTRACT(IF(c.config_key LIKE 'paya/open/%', c.config_value, '{}'),'$.jobKey')) " +
        "WHERE c.config_key LIKE 'paya/open/%' AND t.status = 'running' AND c.updated_at >= NOW() - INTERVAL 5 MINUTE " +
        "ORDER BY c.created_at, c.config_key");
      return rows.flatMap(({ config_value, token_preview, tail }) => {
        const row = JSON.parse(config_value);
        if (row.state !== 'pending' || row.expires <= now()) return [];
        const email = /^([^@\s])[^@\s]*@([a-z0-9.-]+)$/i.exec(String(token_preview || ''));
        return [{ id: row.id, plan: row.plan, amount: row.amount, currency: row.currency, expires: row.expires,
          email: email ? email[1] + '•••@' + email[2] : '', codeTail: tail, jobTail: row.jobKey.slice(-6) }];
      });
    });
  }
  async function cardOwnedByAttempt(db, card, lock = false) {
    if (!Number.isSafeInteger(card?.id) || !card.owner) return false;
    const [rows] = await db.execute("SELECT id FROM card_assets WHERE id = ? AND in_use = 1 AND locked_by = ? AND is_active = 1 AND status = '正常'" +
      (lock ? ' FOR UPDATE' : ''), [card.id, card.owner]);
    return rows.length === 1;
  }
  const ownsCard = card => transaction(db => cardOwnedByAttempt(db, card));
  return { policy, setPolicy, automaticAllowed, open, get, decide, finish, list, ownsCard };
}

// Accept only an explicit total due today. Never infer an amount from a monthly price or trial marketing.
export function checkoutQuote(text) {
  const money = '(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]{1,2})?';
  const currency = '(?:US\\$|USD|PHP|EGP|EUR|GBP|₱|€|£|\\$)';
  const matches = [];
  for (const label of String(text).matchAll(/(?:total due today|amount due today|due today|pay today|今日应付(?:金额)?|今天应付|本次应付|今日應付)\s*[:：]?\s*/gi)) {
    const line = String(text).slice(label.index + label[0].length).split(/\r?\n/)[0].trim();
    const prefix = new RegExp('^(' + currency + ')\\s*(' + money + ')(?:\\s+([A-Z]{3}))?$', 'i').exec(line);
    const suffix = !prefix && new RegExp('^(' + money + ')\\s*(' + currency + ')$', 'i').exec(line);
    if (!prefix && !suffix) return null;
    const unit = (prefix?.[1] || suffix[2]).toUpperCase();
    const aliases = { 'US$': 'USD', '₱': 'PHP', '€': 'EUR', '£': 'GBP' };
    const iso = aliases[unit] || (unit === '$' ? prefix?.[3]?.toUpperCase() : unit);
    if (!iso || !/^(USD|PHP|EGP|EUR|GBP)$/.test(iso) || (prefix?.[3] && iso !== prefix[3].toUpperCase())) return null;
    const value = Number((prefix?.[2] || suffix[1]).replaceAll(',', ''));
    if (!Number.isFinite(value) || value > 1e8) return null;
    matches.push({ amount: value.toFixed(2), currency: iso });
  }
  const first = matches[0];
  return first && matches.every(q => q.amount === first.amount && q.currency === first.currency) ? first : null;
}

export async function authorizeSubmit({ approvals, jobKey, plan, admissionVersion, readQuote, currentPage,
  card, debug, wait = sleep, now = Date.now, emit = console.log }) {
  if (debug || !job.test(jobKey) || !plans.has(plan)) return false;
  if (await approvals.automaticAllowed(admissionVersion).catch(() => false)) return true;
  if (!card || !Number.isFinite(card.deadline) || card.deadline <= now() || !await approvals.ownsCard(card)) return false;
  const initialPage = currentPage();
  const deadline = Math.min(card.deadline, now() + approvalLifetime);
  while (initialPage && currentPage() === initialPage && now() < deadline) {
    const quote = await readQuote();
    if (!quote) return false;
    const row = await approvals.open(jobKey, plan, quote, deadline);
    emit('PAYMENT_APPROVAL_WAITING');
    let end = 'expired';
    try {
      while (now() < row.expires && currentPage() === initialPage) {
        const live = await approvals.get(row.id);
        if (!live || live.state === 'cancelled') { end = 'cancelled'; break; }
        if (live.state === 'approved') {
          const latest = await readQuote();
          if (currentPage() !== initialPage) { end = 'invalidated'; break; }
          if (!latest || latest.amount !== quote.amount || latest.currency !== quote.currency) { end = 'changed'; break; }
          try { await approvals.finish(row.id, 'consumed', latest, card); }
          catch (error) { if (error.status !== 409) throw error; end = 'invalidated'; break; }
          end = 'consumed';
          return true;
        }
        if (live.state !== 'pending') break;
        await wait(800);
      }
    } finally {
      if (end !== 'consumed') await approvals.finish(row.id, end);
      emit('PAYMENT_APPROVAL_WAIT_OVER');
    }
    if (end !== 'changed') break;
  }
  return false;
}

