const upgradePattern = /^upg_[a-f0-9]{32}$/;
const invoicePattern = /^in_[A-Za-z0-9]{1,180}$/;
const intentPattern = /^pi_[A-Za-z0-9]{1,180}$/;

export function isSupportedRechargeUpgrade(current: unknown, target: unknown) {
  return (
    (current === 'go' && target === 'plus') ||
    (current === 'plus' && ['pro-5x', 'pro-20x', 'pro-500'].includes(String(target)))
  );
}

export function isRechargeUpgrade(result: Record<string, unknown>) {
  const quote = result.quote as { plan?: unknown } | undefined;
  return (
    result.operation === 'subscription_upgrade' &&
    typeof result.upgrade_identifier === 'string' &&
    upgradePattern.test(result.upgrade_identifier) &&
    isSupportedRechargeUpgrade(result.current_plan_before, result.target_plan ?? quote?.plan) &&
    (result.target_plan === undefined ||
      quote?.plan === undefined ||
      result.target_plan === quote.plan) &&
    typeof (result.target_plan ?? quote?.plan) === 'string'
  );
}

export function hasOfficialRechargeQuote(result: Record<string, unknown>) {
  return result.operation === 'subscription_upgrade'
    ? isRechargeUpgrade(result) && result.quote_authority === 'official_upgrade_preview'
    : result.quote_authority === 'official_checkout_response' &&
        (result.current_plan_before === undefined || result.current_plan_before === 'free');
}

export function hasVerifiedRechargePayment(
  result: Record<string, unknown>,
  job: { action: string; accountKey: string | null; plan: string }
) {
  const quote = result.quote as { plan?: unknown } | undefined;
  return (
    isRechargePaymentAction(job.action) &&
    result.payment_status === 'paid' &&
    result.payment_outcome === 'subscription_activated' &&
    result.status === 'subscription_activated' &&
    result.account_matched === true &&
    hasOfficialRechargeQuote(result) &&
    result.payment_requests_sent === 1 &&
    !!job.accountKey &&
    quote?.plan === job.plan &&
    (!isRechargeUpgrade(result) || result.target_plan === job.plan)
  );
}

export function isRechargePaymentAction(action: string) {
  return ['prepare', 'flow', 'bitbrowser', 'server'].includes(action);
}

export function rechargeOperationIdentifier(result: Record<string, unknown>) {
  return isRechargeUpgrade(result) ? result.upgrade_identifier : result.checkout_identifier;
}

export function rechargeUpgradeRecheckBinding(result: Record<string, unknown>, plan: string) {
  const quote = result.quote as { plan?: unknown } | undefined;
  if (
    !isRechargeUpgrade(result) ||
    !hasOfficialRechargeQuote(result) ||
    result.target_plan !== plan ||
    quote?.plan !== plan
  )
    return null;
  return {
    operation: 'subscription_upgrade',
    upgrade_identifier: result.upgrade_identifier,
    current_plan_before: result.current_plan_before,
    target_plan: plan,
    quote: result.quote,
    quote_authority: result.quote_authority
  };
}

export function rechargeUpgradePaymentReference(result: Record<string, unknown>) {
  const evidence = result.payment_evidence as { kind?: unknown; identifier?: unknown } | undefined;
  if (
    evidence?.kind === 'invoice' &&
    typeof evidence.identifier === 'string' &&
    invoicePattern.test(evidence.identifier) &&
    evidence.identifier === result.upgrade_invoice_identifier
  )
    return evidence.identifier;
  if (
    evidence?.kind === 'payment_intent' &&
    typeof evidence.identifier === 'string' &&
    intentPattern.test(evidence.identifier) &&
    evidence.identifier === result.upgrade_payment_intent_identifier
  )
    return evidence.identifier;
  return null;
}
