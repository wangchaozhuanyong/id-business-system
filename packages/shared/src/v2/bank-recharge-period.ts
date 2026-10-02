/** 银充默认周期含开通当天共 30 天：1 月 1 日开通，1 月 30 日同一时刻到期。 */
export function bankRechargeDefaultDueAt(openedAt: Date | string): Date {
  const instant = openedAt instanceof Date ? openedAt.getTime() : Date.parse(openedAt);
  if (!Number.isFinite(instant)) throw new Error('银充开通时间无效');
  return new Date(instant + 29 * 24 * 60 * 60 * 1000);
}
