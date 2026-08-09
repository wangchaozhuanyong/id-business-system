import {
  V2_DATA_SCOPES,
  isV2DataScope,
  type V2ChangeEvent,
  type V2ChangeVersionsResult,
  type V2DataScope
} from '@apple-business/shared';

export function parseV2ChangeEvent(payload: unknown): V2ChangeEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as Partial<V2ChangeEvent> & { id?: unknown };
  const rootKeys = Object.keys(candidate);
  if (
    (rootKeys.length !== 4 && rootKeys.length !== 5) ||
    !rootKeys.every((key) =>
      ['id', 'schemaVersion', 'eventId', 'occurredAt', 'scopes'].includes(key)
    ) ||
    ('id' in candidate && (typeof candidate.id !== 'string' || !candidate.id)) ||
    candidate.schemaVersion !== 1 ||
    typeof candidate.eventId !== 'string' ||
    !candidate.eventId ||
    typeof candidate.occurredAt !== 'string' ||
    Number.isNaN(Date.parse(candidate.occurredAt)) ||
    !Array.isArray(candidate.scopes)
  ) {
    return null;
  }

  const scopes = candidate.scopes.filter(
    (item): item is V2ChangeEvent['scopes'][number] =>
      Boolean(item) &&
      typeof item === 'object' &&
      Object.keys(item).length === 2 &&
      Object.keys(item).every((key) => key === 'scope' || key === 'version') &&
      isV2DataScope(item.scope) &&
      typeof item.version === 'string' &&
      /^\d+$/.test(item.version)
  );
  if (!scopes.length || scopes.length !== candidate.scopes.length) return null;

  return {
    schemaVersion: 1,
    eventId: candidate.eventId,
    occurredAt: candidate.occurredAt,
    scopes
  };
}

export function getChangedV2Scopes(
  result: V2ChangeVersionsResult,
  versions: ReadonlyMap<V2DataScope, bigint>
) {
  const changed: V2DataScope[] = [];
  for (const scope of V2_DATA_SCOPES) {
    const value = result.versions[scope];
    if (typeof value !== 'string' || !/^\d+$/.test(value)) continue;
    if (BigInt(value) > (versions.get(scope) ?? 0n)) changed.push(scope);
  }
  return changed;
}
