import { Injectable } from '@nestjs/common';
import type { IdBusinessV2ActivationStatus } from '@prisma/client';

export const ID_BUSINESS_V2_DUE_STATUS_CODES = [
  'active',
  'due_within_7_days',
  'due_within_23_hours',
  'due_within_1_hour',
  'expired',
  'cancelled',
  'abnormal'
] as const;

export type IdBusinessV2ActivationDueStatus = (typeof ID_BUSINESS_V2_DUE_STATUS_CODES)[number];

export interface IdBusinessV2ActivationStatusSnapshot {
  code: IdBusinessV2ActivationDueStatus;
  label: string;
  hoursRemaining: number | null;
  daysRemaining: number | null;
}

export type IdBusinessV2ActivationDueStatusFilter =
  | {
      kind: 'stored_status';
      status: 'cancelled' | 'abnormal';
    }
  | {
      kind: 'expired';
      evaluatedAt: Date;
    }
  | {
      kind: 'active';
      after: Date;
    }
  | {
      kind: 'due_window';
      after: Date;
      atOrBefore: Date;
    };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

@Injectable()
export class IdBusinessV2ActivationStatusService {
  getNextRevalidateAt(dueAt: Date | null, now = new Date(), warningDays?: number) {
    if (!dueAt) return null;
    const warningBoundary =
      warningDays === undefined ? [] : [dueAt.getTime() - warningDays * DAY_MS];
    const nextBoundary = [
      ...warningBoundary,
      dueAt.getTime() - 7 * DAY_MS,
      dueAt.getTime() - 23 * HOUR_MS,
      dueAt.getTime() - HOUR_MS,
      dueAt.getTime()
    ]
      .filter((timestamp) => timestamp > now.getTime())
      .sort((left, right) => left - right)[0];
    return nextBoundary === undefined ? null : new Date(nextBoundary);
  }

  resolve(
    storedStatus: IdBusinessV2ActivationStatus,
    dueAt: Date | null,
    now = new Date()
  ): IdBusinessV2ActivationStatusSnapshot {
    if (storedStatus === 'cancelled') {
      return this.snapshot('cancelled', '已取消', null);
    }
    if (storedStatus === 'abnormal') {
      return this.snapshot('abnormal', '异常', null);
    }
    if (storedStatus === 'expired') {
      return this.snapshot('expired', '已到期', dueAt ? dueAt.getTime() - now.getTime() : null);
    }
    if (!dueAt) {
      return this.snapshot('active', '正常', null);
    }

    const remainingMs = dueAt.getTime() - now.getTime();
    if (remainingMs <= 0) {
      return this.snapshot('expired', '已到期', remainingMs);
    }
    if (remainingMs <= HOUR_MS) {
      return this.snapshot('due_within_1_hour', '1小时内到期', remainingMs);
    }
    if (remainingMs <= 23 * HOUR_MS) {
      return this.snapshot('due_within_23_hours', '23小时内到期', remainingMs);
    }
    if (remainingMs <= 7 * DAY_MS) {
      return this.snapshot('due_within_7_days', '7天内到期', remainingMs);
    }
    return this.snapshot('active', '正常', remainingMs);
  }

  getFilterWindow(
    dueStatus: IdBusinessV2ActivationDueStatus,
    now = new Date()
  ): IdBusinessV2ActivationDueStatusFilter {
    const evaluatedAt = new Date(now.getTime());
    if (dueStatus === 'cancelled' || dueStatus === 'abnormal') {
      return {
        kind: 'stored_status',
        status: dueStatus
      };
    }
    if (dueStatus === 'expired') {
      return {
        kind: 'expired',
        evaluatedAt
      };
    }

    const oneHourBoundary = new Date(now.getTime() + HOUR_MS);
    const twentyThreeHourBoundary = new Date(now.getTime() + 23 * HOUR_MS);
    const sevenDayBoundary = new Date(now.getTime() + 7 * DAY_MS);
    if (dueStatus === 'active') {
      return {
        kind: 'active',
        after: sevenDayBoundary
      };
    }
    if (dueStatus === 'due_within_1_hour') {
      return {
        kind: 'due_window',
        after: evaluatedAt,
        atOrBefore: oneHourBoundary
      };
    }
    if (dueStatus === 'due_within_23_hours') {
      return {
        kind: 'due_window',
        after: oneHourBoundary,
        atOrBefore: twentyThreeHourBoundary
      };
    }
    return {
      kind: 'due_window',
      after: twentyThreeHourBoundary,
      atOrBefore: sevenDayBoundary
    };
  }

  private snapshot(
    code: IdBusinessV2ActivationDueStatus,
    label: string,
    remainingMs: number | null
  ): IdBusinessV2ActivationStatusSnapshot {
    const hoursRemaining = remainingMs === null ? null : Math.ceil(remainingMs / HOUR_MS);
    const daysRemaining = remainingMs === null ? null : Math.ceil(remainingMs / DAY_MS);
    return {
      code,
      label,
      hoursRemaining: Object.is(hoursRemaining, -0) ? 0 : hoursRemaining,
      daysRemaining: Object.is(daysRemaining, -0) ? 0 : daysRemaining
    };
  }
}
