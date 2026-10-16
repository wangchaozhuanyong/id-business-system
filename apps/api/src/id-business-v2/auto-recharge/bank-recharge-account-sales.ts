import { BadRequestException, ConflictException } from '@nestjs/common';
import type { IdBusinessV2ChatgptAccount } from '@prisma/client';

export type ChatgptAccountSaleStatus = 'unsold' | 'sold';

export function parseChatgptAccountSaleStatus(value: unknown): ChatgptAccountSaleStatus {
  if (value !== 'unsold' && value !== 'sold') throw new BadRequestException('出售情况无效');
  return value;
}

export function accountSaleUpdate(
  before: Pick<IdBusinessV2ChatgptAccount, 'registered' | 'saleStatus' | 'soldAt'>,
  saleStatus: ChatgptAccountSaleStatus | undefined,
  now = new Date()
) {
  if (saleStatus === undefined) return {};
  if (saleStatus === 'sold' && !before.registered)
    throw new ConflictException('只有已标记注册的账号才能标记已出售');
  if (saleStatus === before.saleStatus) return {};
  return { saleStatus, soldAt: saleStatus === 'sold' ? now : null };
}
