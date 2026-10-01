import { ConflictException, BadRequestException } from '@nestjs/common';
import type { V2VendureMailboxAlias } from '@apple-business/shared';
import { IdBusinessV2VendureMailboxClient } from './providers/id-business-v2-vendure-mailbox.client';

export async function ensureVendureAccountAliases(
  client: IdBusinessV2VendureMailboxClient,
  primaryAccountId: string,
  emails: string[],
  create: (rawInput: string) => Promise<unknown>
) {
  const primary = (await client.primaryAccounts()).find((item) => item.id === primaryAccountId);
  if (!primary || primary.status !== 'ACTIVE')
    throw new BadRequestException('请选择邮件验证码查询中的正常主邮箱');
  const normalized = [...new Set(emails.map((email) => email.trim().toLowerCase()))];
  if (normalized.includes(primary.email.trim().toLowerCase()))
    throw new BadRequestException('账号资料应填写隐藏邮箱，不能将所属主邮箱作为虚拟邮箱');
  const assertAliases = (aliases: V2VendureMailboxAlias[]) => {
    const existing = new Set<string>();
    for (const email of normalized) {
      const matches = aliases.filter((item) => item.aliasEmail.trim().toLowerCase() === email);
      if (matches.length > 1 || matches.some((item) => item.primaryAccountId !== primaryAccountId))
        throw new ConflictException(
          '导入邮箱已关联其他主邮箱或关联不唯一，请先核对；不会自动更换归属'
        );
      if (matches.some((item) => item.status !== 'ACTIVE'))
        throw new ConflictException('导入邮箱已停用，请先在邮件验证码查询中核对');
      if (matches.length === 1) existing.add(email);
    }
    return existing;
  };
  const existing = assertAliases(await client.virtualEmails());
  const missing = normalized.filter((email) => !existing.has(email));
  if (!missing.length) return;
  await create(missing.join('\n'));
  const verified = assertAliases(await client.virtualEmails());
  if (normalized.some((email) => !verified.has(email)))
    throw new ConflictException(
      '部分隐藏邮箱尚未加入邮箱验证码查询，账号整批未导入；请重试，已添加的邮箱会自动复用'
    );
}
