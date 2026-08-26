export function getOrCreateOrderActionKey(
  keys: Map<string, string>,
  action: 'consume' | 'cancel' | 'refund' | 'upgrade-return' | 'upgrade-return-reverse',
  orderId: string
) {
  const name = `${action}:${orderId}`;
  const existing = keys.get(name);
  if (existing) return existing;
  const key =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? `${action}-${crypto.randomUUID()}`
      : `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  keys.set(name, key);
  return key;
}
