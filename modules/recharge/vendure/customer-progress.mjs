import { rechargeTaskStepHistory } from '../codexdaichong/progress-presentation.mjs';

export const customerStepKeys = ['accepted', 'account', 'checkout', 'card', 'billing', 'payment', 'subscription', 'complete'];
const stages = new Map([
  ['checkout_api_ready', ['checkout', 'active']], ['checkout_page_ready', ['checkout', 'active']],
  ['checkout_open', ['checkout', 'complete']], ['checkout_wait', ['checkout', 'active']],
  ['payment_details', ['card', 'active']], ['card_fields_entered', ['card', 'complete']],
  ['billing_details', ['billing', 'active']], ['billing_form_wait', ['billing', 'active']],
  ['billing_entered', ['billing', 'complete']], ['payment_submit_attempt', ['payment', 'active']],
  ['payment_submitted', ['payment', 'waiting']], ['payment_check', ['payment', 'waiting']],
  ['subscription_check', ['subscription', 'active']], ['card_retry', ['card', 'active']]
]);

/** Project the matching job/attempt only. URL creation is not proof a page opened. */
export function customerFacts(body, jobKey, code) {
  if (body?.success !== true || body.task?.jobKey !== jobKey || body.task?.cdk !== code) return [];
  const history = rechargeTaskStepHistory(body, { jobKey, status: body.task.status });
  const records = [...(history?.steps ?? [])];
  for (const entry of body.runtimeEntries ?? []) {
    const attempt = /^spawn\/a([1-9]\d{0,2})\/stdout$/.exec(entry?.source ?? '');
    if (!attempt || entry.jobKey !== jobKey || !Number.isSafeInteger(entry.ts) || entry.ts <= 0) continue;
    if (entry.text === '🔐 [步骤] 正在使用 Session 登录 ChatGPT...')
      records.push({ stage: 'customer_login', at: entry.ts, attempt: Number(attempt[1]) });
    if (/^✅ \[步骤\] Session 登录成功: [^\s@]+@[^\s@]+$/.test(entry.text ?? ''))
      records.push({ stage: 'customer_login_ok', at: entry.ts, attempt: Number(attempt[1]) });
  }
  const attempt = Math.max(0, ...records.map(step => step.attempt ?? 0));
  const current = records.filter(step => step.attempt === attempt).sort((a, b) => a.at - b.at);
  const round = Math.max(0, ...current.filter(step => step.stage === 'card_retry').map(step => step.at));
  const fields = new Set();
  const latest = new Map();
  const rank = { active: 0, waiting: 1, complete: 2 };
  for (const step of current) {
    let mapping = step.stage === 'customer_login' ? ['account', 'active'] :
      step.stage === 'customer_login_ok' ? ['account', 'complete'] : stages.get(step.stage);
    if (step.at >= round && ['card_number_entered', 'card_expiry_entered', 'card_security_entered'].includes(step.stage)) {
      fields.add(step.stage);
      if (fields.size === 3) mapping = ['card', 'complete'];
    }
    if (!mapping || (step.at < round && !['account', 'checkout'].includes(mapping[0]))) continue;
    const fact = { key: mapping[0], state: mapping[1], at: step.at, attempt, round };
    const prior = latest.get(fact.key);
    if (!prior || rank[fact.state] > rank[prior.state]) latest.set(fact.key, fact);
  }
  return [...latest.values()];
}

export function safeCustomerFacts(input, now) {
  if (!Array.isArray(input) || input.length > 8) return [];
  return input.filter(fact => fact && ['account', 'checkout', 'card', 'billing', 'payment', 'subscription'].includes(fact.key) &&
    (['active', 'complete'].includes(fact.state) || (fact.key === 'payment' && fact.state === 'waiting')) &&
    Number.isSafeInteger(fact.at) && fact.at > 0 && fact.at <= now + 30_000 &&
    Number.isSafeInteger(fact.attempt) && fact.attempt >= 1 && fact.attempt <= 999 &&
    (fact.round === undefined || (Number.isSafeInteger(fact.round) && fact.round >= 0 && fact.round <= now + 30_000)))
    .map(({ key, state, at, attempt, round = 0 }) => ({ key, state, at, attempt, round }));
}

export function customerEmail(session) {
  try {
    const email = JSON.parse(session).user?.email;
    return typeof email === 'string' && email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : undefined;
  } catch { return undefined; }
}

/** Lease heartbeats never advance this business revision or its displayed time. */
export function projectCustomerProgress(task, prior, at, input = []) {
  const old = prior?.progress;
  const facts = safeCustomerFacts(input, at);
  const execution = Math.max(old?.execution ?? 0, ...facts.map(fact => fact.attempt));
  const round = Math.max(execution === old?.execution ? Date.parse(old?.retryAt ?? '') || 0 : 0, ...facts.filter(fact => fact.attempt === execution).map(fact => fact.round));
  const retryAt = round ? new Date(round).toISOString() : null;
  const milestones = new Map((old?.milestones ?? []).filter(step =>
    step.key === 'accepted' || (execution === old.execution && (retryAt === (old.retryAt ?? null) || ['account', 'checkout'].includes(step.key))))
    .map(step => [step.key, step]));
  const put = (key, state, when) => {
    const previous = milestones.get(key);
    if (previous && (Date.parse(previous.at) > when || previous.state === 'complete' || (previous.state === 'waiting' && state === 'active'))) return;
    if (previous?.state === state) return;
    milestones.set(key, { key, state, at: new Date(when).toISOString() });
  };
  if (!old && task.status === 'queued') put('accepted', 'complete', at);
  for (const fact of facts.filter(fact => fact.attempt === execution && fact.round >= round).sort((a, b) => a.at - b.at))
    put(fact.key, fact.state, fact.at);
  if (task.status === 'running') {
    if (task.stage === 'payment_details' && !milestones.has('card')) put('card', 'active', at);
    if (task.stage === 'paying') put('payment', 'active', at);
    if (task.stage === 'paid') { put('payment', 'complete', at); put('subscription', 'active', at); }
    if (task.stage === 'subscription_check') put('subscription', 'active', at);
  }
  if (task.status === 'succeeded') put('complete', 'complete', at);
  const next = { execution, retryAt, milestones: [...milestones.values()].sort((a, b) => customerStepKeys.indexOf(a.key) - customerStepKeys.indexOf(b.key)) };
  const changed = !old || prior.status !== task.status || prior.stage !== task.stage ||
    JSON.stringify({ execution: old.execution, retryAt: old.retryAt ?? null, milestones: old.milestones }) !== JSON.stringify(next);
  return { ...task, progress: changed ? {
    attempt: task.id, version: (old?.version ?? 0) + 1, changedAt: new Date(at).toISOString(), ...next
  } : old };
}
