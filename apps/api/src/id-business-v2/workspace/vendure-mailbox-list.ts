export function paginateVendureMailboxes<T>(items: T[], page: number, pageSize: number) {
  const ordered = [...items].sort((left, right) =>
    mailboxUpdatedAt(right).localeCompare(mailboxUpdatedAt(left))
  );
  return {
    items: ordered.slice((page - 1) * pageSize, page * pageSize),
    total: ordered.length,
    page,
    pageSize
  };
}

function mailboxUpdatedAt(value: unknown) {
  const record = value as { updatedAt?: unknown; receivedAt?: unknown };
  return String(record.receivedAt ?? record.updatedAt ?? '');
}

export function vendureMailboxIncludes(value: unknown, query: string, keys: string[]) {
  const record = value as Record<string, unknown>;
  return keys.some((key) =>
    String(record[key] ?? '')
      .toLocaleLowerCase()
      .includes(query)
  );
}
