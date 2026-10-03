/** 银充提醒按北京时间自然月计算，续费同日前一天到期；月底夹到下月最后一天。 */
export function bankRechargeDefaultDueAt(openedAt: Date | string): Date {
  const instant = openedAt instanceof Date ? openedAt.getTime() : Date.parse(openedAt);
  if (!Number.isFinite(instant)) throw new Error('银充开通时间无效');
  const businessOffset = 8 * 60 * 60 * 1000;
  const businessDate = new Date(instant + businessOffset);
  const monthStart = new Date(
    Date.UTC(businessDate.getUTCFullYear(), businessDate.getUTCMonth() + 1, 1)
  );
  const lastDay = new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)
  ).getUTCDate();
  const renewalDate = new Date(businessDate);
  renewalDate.setUTCDate(1);
  renewalDate.setUTCFullYear(monthStart.getUTCFullYear(), monthStart.getUTCMonth());
  renewalDate.setUTCDate(Math.min(businessDate.getUTCDate(), lastDay) - 1);
  return new Date(renewalDate.getTime() - businessOffset);
}
