import type { Prisma } from '@prisma/client';

export interface CreateAuditLogInput {
  userId?: string;
  module: string;
  action: string;
  objectType?: string;
  objectId?: string;
  beforeData?: Prisma.InputJsonValue;
  afterData?: Prisma.InputJsonValue;
  ip?: string;
  userAgent?: string;
  remark?: string;
}
