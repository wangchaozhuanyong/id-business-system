import { Injectable } from '@nestjs/common';
import type { V2CommandTransaction } from '../id-business-v2-command-transaction.service';

export type V2JsonPrimitive = string | number | boolean | null;
export type V2JsonValue = V2JsonPrimitive | V2JsonValue[] | { [key: string]: V2JsonValue };
export type V2JsonDocument = Exclude<V2JsonValue, null>;

export function toV2JsonDocument(value: unknown): V2JsonDocument {
  return JSON.parse(JSON.stringify(value)) as V2JsonDocument;
}

const SENSITIVE_AUDIT_KEYS = new Set([
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'securityinfo',
  'securityanswers',
  'phone',
  'phonenumber',
  'phoneencrypted',
  'cardnumber',
  'giftcardnumber',
  'token',
  'tokenhash',
  'accesstoken',
  'refreshtoken',
  'jwt',
  'secret',
  'secretencrypted',
  'recoverycodes'
]);

export interface V2TransactionalAuditInput {
  userId?: string;
  module: string;
  action: string;
  objectType?: string;
  objectId?: string;
  beforeData?: V2JsonDocument;
  afterData?: V2JsonDocument;
  ip?: string;
  userAgent?: string;
  remark?: string;
}

@Injectable()
export class V2TransactionalAuditService {
  append(tx: V2CommandTransaction, input: V2TransactionalAuditInput) {
    return tx.auditLog.create({
      data: {
        userId: input.userId,
        module: input.module,
        action: input.action,
        objectType: input.objectType,
        objectId: input.objectId,
        beforeData: sanitizeAuditDocument(input.beforeData),
        afterData: sanitizeAuditDocument(input.afterData),
        ip: input.ip,
        userAgent: input.userAgent,
        remark: input.remark
      }
    });
  }
}

function sanitizeAuditDocument(value: V2JsonDocument | undefined): V2JsonDocument | undefined {
  if (value === undefined) return undefined;
  return sanitizeAuditValue(value) as V2JsonDocument;
}

function sanitizeAuditValue(value: V2JsonValue): V2JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditValue(item));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_AUDIT_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : sanitizeAuditValue(item)
    ])
  );
}
