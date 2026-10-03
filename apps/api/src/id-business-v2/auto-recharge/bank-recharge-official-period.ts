/** 已核实的官网账期只用于到期提醒；本次开通时间仍取本次成功时间。 */
export function officialBankRechargeDueAt(
  result: Record<string, unknown>,
  job: { accountKey: string | null; plan: string },
  verifiedAt: Date
): Date | null {
  const period = result.subscription_period as
    | { source?: string; start?: string; end?: string; account_key?: string; target_plan?: string }
    | undefined;
  if (
    period?.source !== 'official_subscription_response' ||
    period.account_key !== job.accountKey ||
    period.target_plan !== job.plan ||
    typeof period.start !== 'string' ||
    typeof period.end !== 'string' ||
    !Number.isFinite(Date.parse(period.start)) ||
    !Number.isFinite(Date.parse(period.end)) ||
    Date.parse(period.start) > verifiedAt.getTime() ||
    Date.parse(period.end) <= verifiedAt.getTime() ||
    Date.parse(period.end) - 24 * 60 * 60 * 1000 <= verifiedAt.getTime() ||
    Date.parse(period.end) - Date.parse(period.start) > 32 * 24 * 60 * 60 * 1000
  )
    return null;
  return new Date(Date.parse(period.end) - 24 * 60 * 60 * 1000);
}
