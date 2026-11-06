const millisecondsPerHour = 60 * 60 * 1000;

export const DEFAULT_CLAUDE_AGING_HOURS = 72;
export const MAX_CLAUDE_AGING_HOURS = 8760;

export function claudeAgeHours(registeredAt: Date | null, businessTime: Date): number | null {
  if (!registeredAt || registeredAt > businessTime) return null;
  return Math.floor((businessTime.getTime() - registeredAt.getTime()) / millisecondsPerHour);
}

export function claudeAgingCutoff(businessTime: Date, agingHours: number) {
  return new Date(businessTime.getTime() - agingHours * millisecondsPerHour);
}

export function isClaudeAged(registeredAt: Date | null, businessTime: Date, agingHours: number) {
  return Boolean(registeredAt && registeredAt <= claudeAgingCutoff(businessTime, agingHours));
}
