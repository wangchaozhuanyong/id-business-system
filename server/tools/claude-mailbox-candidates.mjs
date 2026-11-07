// Pending connections are projected from inventory; no credentials or query codes are created.
export function withClaudeMailboxCandidates(metadata, inventory) {
  const items = metadata.items.map(row => ({ ...row }));
  const byEmail = new Map(items.map(row => [row.email.trim().toLowerCase(), row]));
  for (const account of inventory?.accounts || []) {
    if (account.type !== 'claude' || typeof account.email !== 'string') continue;
    const email = account.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    const existing = byEmail.get(email);
    if (existing) { existing.source = 'claude'; continue; }
    const provider = { google: 'google', '谷歌邮箱': 'google', apple: 'apple', '苹果邮箱': 'apple',
      microsoft: 'microsoft', '微软邮箱': 'microsoft', relay: 'relay', '苹果隐藏邮箱': 'relay' }[account.emailType] || '';
    const row = { id: `claude:${account.id}`, email, provider, label: '', source: 'claude',
      authorizationPending: true, active: false, authFailed: false, expiresAt: null, lastQueriedAt: null };
    items.push(row);
    byEmail.set(email, row);
  }
  return { ...metadata, items };
}
