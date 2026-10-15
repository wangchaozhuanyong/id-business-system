import { BadRequestException } from '@nestjs/common';
import type { RechargeRepository } from './persistence/recharge.repository';
import { presentRechargeJobs } from './recharge-job-list';

export function rechargeReviewQuery(value: Record<string, unknown>) {
  const page = Number(value.page ?? 1),
    pageSize = Number(value.pageSize ?? 20);
  const search = String(value.search ?? '').trim();
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    search.length > 100 ||
    [...search].some((char) => char.charCodeAt(0) < 32)
  )
    throw new BadRequestException('执行记录查询条件无效');
  return { page, pageSize, search };
}

export async function reviewRechargeJobs(
  repository: RechargeRepository,
  ownerId: string,
  query: Record<string, unknown>,
  token: string
) {
  const options = rechargeReviewQuery(query);
  const { items, total } = await repository.reviewPage(ownerId, options);
  const keys = [
    ...new Set(items.map((job) => job.accountKey).filter((key): key is string => Boolean(key)))
  ];
  const records = keys.length ? await repository.paymentRecords(ownerId, keys, true) : [];
  const verificationItems = keys.length
    ? await repository.verificationCandidates(ownerId, keys)
    : [];
  return {
    items: presentRechargeJobs(items, records, token, [...items, ...verificationItems]),
    total,
    page: options.page,
    pageSize: options.pageSize
  };
}
