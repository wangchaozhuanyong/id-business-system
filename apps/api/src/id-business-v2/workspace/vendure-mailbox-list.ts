import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { IdBusinessV2VendureMailboxClient } from './providers/id-business-v2-vendure-mailbox.client';
import type { V2VendureMailboxSyncResult } from '@apple-business/shared';

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

export async function syncVendureMailboxScope(
  client: IdBusinessV2VendureMailboxClient,
  { primaryAccountId, virtualEmailId }: { primaryAccountId?: string; virtualEmailId?: string },
  sync: (id: string) => Promise<unknown>
) {
  const accounts = await client.primaryAccounts();
  const alias = virtualEmailId
    ? (await client.virtualEmails(primaryAccountId)).find((item) => item.id === virtualEmailId)
    : undefined;
  if (
    virtualEmailId &&
    (!alias || (primaryAccountId && alias.primaryAccountId !== primaryAccountId))
  )
    throw new BadRequestException('虚拟邮箱与主邮箱不匹配');
  const targetId = primaryAccountId || alias?.primaryAccountId;
  const targets = accounts.filter(
    (item) => (!targetId || item.id === targetId) && item.status !== 'DISABLED'
  );
  if (targetId && targets.length === 0) throw new BadRequestException('主邮箱不存在或已禁用');
  for (const account of targets) {
    const result = (await sync(account.id)) as V2VendureMailboxSyncResult;
    if ('success' in result && !result.success)
      throw new ServiceUnavailableException('收件同步失败，请在主邮箱管理检查连接后重试');
  }
}
