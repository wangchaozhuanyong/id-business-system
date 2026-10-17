export const ORIGINAL_RECHECK_DELAYS_MS = [60000, 300000, 900000] as const;
export interface OriginalRecheckSchedule {
  version: 1;
  startedAt: string;
  attempts: number;
  nextAttemptAt: string | null;
  stopped: boolean;
  reasonCode?:
    | 'legacy_original_identity_missing'
    | 'original_session_missing'
    | 'original_submission_missing'
    | 'original_route_missing'
    | 'attempts_exhausted';
  lastTaskId?: string;
}
export function originalRecheckSchedule(value: unknown, startedAt: Date): OriginalRecheckSchedule {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const started =
    typeof record.startedAt === 'string' && Number.isFinite(Date.parse(record.startedAt))
      ? record.startedAt
      : startedAt.toISOString();
  const attempts =
    typeof record.attempts === 'number' && Number.isInteger(record.attempts)
      ? Math.max(0, Math.min(3, record.attempts))
      : 0;
  const stopped = record.stopped === true || attempts >= 3;
  return {
    version: 1,
    startedAt: started,
    attempts,
    nextAttemptAt: !stopped
      ? new Date(Date.parse(started) + ORIGINAL_RECHECK_DELAYS_MS[attempts]!).toISOString()
      : null,
    stopped,
    ...([
      'legacy_original_identity_missing',
      'original_session_missing',
      'original_submission_missing',
      'original_route_missing',
      'attempts_exhausted'
    ].includes(String(record.reasonCode))
      ? { reasonCode: record.reasonCode as OriginalRecheckSchedule['reasonCode'] }
      : {}),
    ...(typeof record.lastTaskId === 'string' ? { lastTaskId: record.lastTaskId } : {})
  };
}
