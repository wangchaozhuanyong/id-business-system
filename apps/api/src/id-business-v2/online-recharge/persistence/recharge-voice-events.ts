import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { ONLINE_RECHARGE_PLANS, type OnlineRechargePlan } from '../contracts';

const PAGE_SIZE = 100;
const OVERLAP_MS = 60_000;
const MAX_CURSOR_LENGTH = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface VoiceCursor {
  baseline: string;
  since: string;
  through?: string;
  after?: { at: string; id: string };
}

export interface RechargeVoiceEventPage {
  items: { id: string; taskId: string; plan: OnlineRechargePlan; createdAt: string }[];
  cursor: string;
  hasMore: boolean;
  // This response is a cursor feed, rather than an ordinary numbered list.
  total?: never;
  page?: never;
  pageSize?: never;
}

function invalidCursor(): never {
  throw new BadRequestException('充值语音提醒游标无效');
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function timestamp(value: unknown, now: number): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const time = Date.parse(value);
  return (
    Number.isFinite(time) &&
    time >= 0 &&
    time <= now + 1000 &&
    new Date(time).toISOString() === value
  );
}

function encode(cursor: VoiceCursor) {
  return `v1.${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`;
}

function decode(value: unknown, now: number): VoiceCursor {
  if (
    typeof value !== 'string' ||
    value.length > MAX_CURSOR_LENGTH ||
    !/^v1\.[A-Za-z0-9_-]+$/.test(value)
  )
    return invalidCursor();
  let parsed: unknown;
  try {
    const encoded = value.slice(3);
    const buffer = Buffer.from(encoded, 'base64url');
    if (buffer.toString('base64url') !== encoded) return invalidCursor();
    parsed = JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    return invalidCursor();
  }
  if (
    !record(parsed) ||
    Object.keys(parsed).some((key) => !['baseline', 'since', 'through', 'after'].includes(key)) ||
    !timestamp(parsed.baseline, now) ||
    !timestamp(parsed.since, now) ||
    parsed.since < parsed.baseline ||
    (parsed.through !== undefined &&
      (!timestamp(parsed.through, now) || parsed.through < parsed.since))
  )
    return invalidCursor();
  if (parsed.after !== undefined) {
    if (
      !parsed.through ||
      !record(parsed.after) ||
      Object.keys(parsed.after).length !== 2 ||
      !timestamp(parsed.after.at, now) ||
      typeof parsed.after.id !== 'string' ||
      !UUID.test(parsed.after.id) ||
      Date.parse(parsed.after.at) <
        Math.max(Date.parse(parsed.baseline), Date.parse(parsed.since) - OVERLAP_MS) ||
      parsed.after.at > parsed.through
    )
      return invalidCursor();
  }
  return parsed as unknown as VoiceCursor;
}

export async function readRechargeVoiceEvents(
  db: Pick<PrismaService, 'onlineRechargeEvent'>,
  rawCursor: unknown,
  now = new Date()
): Promise<RechargeVoiceEventPage> {
  const nowIso = now.toISOString();
  if (rawCursor === 'baseline')
    return { items: [], cursor: encode({ baseline: nowIso, since: nowIso }), hasMore: false };
  const cursor = decode(rawCursor, now.getTime());
  const through =
    cursor.through ?? new Date(Math.max(now.getTime(), Date.parse(cursor.since))).toISOString();
  const lower = new Date(
    Math.max(Date.parse(cursor.baseline), Date.parse(cursor.since) - OVERLAP_MS)
  );
  const where: Prisma.OnlineRechargeEventWhereInput = {
    stage: 'recharge_started',
    createdAt: { gte: lower, lte: new Date(through) },
    ...(cursor.after
      ? {
          OR: [
            { createdAt: { gt: new Date(cursor.after.at) } },
            { createdAt: new Date(cursor.after.at), id: { gt: cursor.after.id } }
          ]
        }
      : {})
  };
  const rows = await db.onlineRechargeEvent.findMany({
    where,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: PAGE_SIZE + 1,
    select: { id: true, taskId: true, createdAt: true, metadata: true }
  });
  const scanned = rows.slice(0, PAGE_SIZE);
  const items = scanned.flatMap((row) => {
    const plan = record(row.metadata) ? row.metadata.plan : null;
    return row.taskId &&
      typeof plan === 'string' &&
      ONLINE_RECHARGE_PLANS.includes(plan as OnlineRechargePlan)
      ? [
          {
            id: row.id,
            taskId: row.taskId,
            plan: plan as OnlineRechargePlan,
            createdAt: row.createdAt.toISOString()
          }
        ]
      : [];
  });
  const hasMore = rows.length > PAGE_SIZE;
  const last = scanned.at(-1);
  const next: VoiceCursor =
    hasMore && last
      ? { ...cursor, through, after: { at: last.createdAt.toISOString(), id: last.id } }
      : { baseline: cursor.baseline, since: through };
  return { items, cursor: encode(next), hasMore };
}
