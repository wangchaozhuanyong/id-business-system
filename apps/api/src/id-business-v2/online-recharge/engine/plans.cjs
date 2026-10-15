'use strict';

// These keys are internal and preserve existing CDKs. A pricing control value is
// not a Checkout API plan_name; the Pro 500 API name must be verified separately.
const PLANS = Object.freeze({
  plus: { rank: 1, label: 'Plus', apiName: 'chatgptplusplan', pricingLabel: null },
  pro_5x: { rank: 2, label: 'Pro 100', apiName: 'chatgptprolite', pricingLabel: '100' },
  pro_20x: { rank: 3, label: 'Pro 200', apiName: 'chatgptpro', pricingLabel: '200' },
  pro_500: { rank: 4, label: 'Pro 500', apiName: null, pricingLabel: '500' }
});
const PLAN_NAMES = Object.freeze({
  plus: ['plus', 'chatgptplus', 'chatgptplusplan'],
  pro_5x: ['pro_5x', 'pro5x', 'chatgptprolite'],
  // "pro" / "chatgptpro" alone is ambiguous with the current tiered product.
  pro_20x: ['pro_20x', 'pro20x'],
  pro_500: ['pro_500']
});
function assertPlan(plan) {
  if (!Object.hasOwn(PLANS, plan)) throw new Error('不支持或无法识别目标套餐，未提交付款');
  return plan;
}
function resolveApiPlanName(plan, override = '') {
  assertPlan(plan);
  const value = String(override || '').trim();
  if (value) return value;
  const name = PLANS[plan].apiName;
  if (!name) throw new Error('Pro 500 的接口套餐标识尚未核实，请使用官网套餐界面');
  return name;
}
function observedCanonicalPlan(raw, options = {}) {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  for (const [key, names] of Object.entries(PLAN_NAMES)) if (names.includes(value)) return key;
  // A verified administrator mapping can be used only for the currently
  // selected new tier. Never reinterpret generic Pro or an existing tier.
  const configured = String(options.pro500Name || '')
    .trim()
    .toLowerCase();
  if (
    configured &&
    !['pro', 'chatgptpro', 'free', 'unknown'].includes(configured) &&
    value === configured
  )
    return 'pro_500';
  return null;
}
function classifyChange(targetPlan, confirmation, active) {
  assertPlan(targetPlan);
  const raw = String(confirmation.observedPlan || '')
    .trim()
    .toLowerCase();
  const sourcePlan =
    active === false && (!raw || raw === 'free')
      ? 'free'
      : active === true && confirmation.tierVerified
        ? confirmation.observedCanonicalPlan
        : null;
  if (!sourcePlan) return { allowed: false, error: '无法确认账号当前准确套餐档位，本次未提交付款' };
  if (sourcePlan === targetPlan)
    return {
      allowed: false,
      alreadyActive: true,
      sourcePlan,
      targetPlan,
      error: '账号已是目标套餐，本次未提交付款，无需重复充值'
    };
  if (sourcePlan === 'free') return { allowed: true, kind: 'initial', sourcePlan, targetPlan };
  if (PLANS[targetPlan].rank <= PLANS[sourcePlan].rank)
    return { allowed: false, sourcePlan, targetPlan, error: '本功能不自动降档，本次未提交付款' };
  return { allowed: true, kind: 'upgrade', sourcePlan, targetPlan };
}
module.exports = {
  PLANS,
  PLAN_NAMES,
  assertPlan,
  resolveApiPlanName,
  observedCanonicalPlan,
  classifyChange
};
