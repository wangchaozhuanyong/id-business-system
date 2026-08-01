import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isUniqueConstraintError, isWriteConflictError } from './id-business-v2-prisma-error';

export type V2CommandTransaction = Prisma.TransactionClient;
export type V2CommandRetryMode = 'none' | 'stableIdempotency' | 'fullReplay';
export type V2TransactionIsolationLevel =
  'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable';

export interface V2CommandContext {
  attempt: number;
  requestId: string;
  operator?: AuthenticatedUser;
  businessTime: Date;
  idempotencyKey?: string;
}

interface V2CommandTransactionBaseOptions {
  requestId: string;
  operator?: AuthenticatedUser;
  businessTime?: Date;
  isolationLevel?: V2TransactionIsolationLevel;
  maxWaitMs?: number;
  timeoutMs?: number;
  uniqueConflictMessage?: string;
  writeConflictMessage?: string;
}

interface V2NonRetryableCommandOptions extends V2CommandTransactionBaseOptions {
  retryMode?: 'none';
  maxWriteConflictRetries?: never;
  idempotencyKey?: never;
  replay?: never;
}

interface V2ReplayableCommandOptions<TResult> extends V2CommandTransactionBaseOptions {
  retryMode: Exclude<V2CommandRetryMode, 'none'>;
  maxWriteConflictRetries?: number;
  idempotencyKey: string;
  replay: (tx: V2CommandTransaction, context: V2CommandContext) => Promise<TResult>;
}

export type V2CommandTransactionOptions<TResult> =
  V2NonRetryableCommandOptions | V2ReplayableCommandOptions<TResult>;

@Injectable()
export class V2CommandTransactionManager {
  constructor(private readonly prisma: PrismaService) {}

  async execute<TResult>(
    work: (tx: V2CommandTransaction, context: V2CommandContext) => Promise<TResult>,
    options: V2CommandTransactionOptions<TResult>
  ) {
    const retryable =
      options.retryMode === 'stableIdempotency' || options.retryMode === 'fullReplay';
    const maxWriteConflictRetries = retryable ? (options.maxWriteConflictRetries ?? 2) : 0;
    const isolationLevel = options.isolationLevel ?? 'Serializable';
    const baseContext = {
      requestId: options.requestId,
      operator: options.operator,
      businessTime: options.businessTime ?? new Date(),
      idempotencyKey: retryable ? options.idempotencyKey : undefined
    };

    for (let attempt = 1; attempt <= maxWriteConflictRetries + 1; attempt += 1) {
      const context: V2CommandContext = { ...baseContext, attempt };
      try {
        return await this.prisma.$transaction((tx) => work(tx, context), {
          isolationLevel,
          maxWait: options.maxWaitMs,
          timeout: options.timeoutMs
        });
      } catch (error) {
        if (isWriteConflictError(error) && retryable && attempt <= maxWriteConflictRetries) {
          continue;
        }

        if (isUniqueConstraintError(error)) {
          if (retryable) {
            const replayContext: V2CommandContext = { ...baseContext, attempt: attempt + 1 };
            return this.prisma.$transaction((tx) => options.replay(tx, replayContext), {
              isolationLevel,
              maxWait: options.maxWaitMs,
              timeout: options.timeoutMs
            });
          }
          throw new ConflictException(
            options.uniqueConflictMessage ?? '数据已被其他操作创建，请刷新后核对'
          );
        }

        if (isWriteConflictError(error)) {
          throw new ConflictException(
            options.writeConflictMessage ?? '数据已被其他操作修改，请刷新后重试'
          );
        }

        throw error;
      }
    }

    throw new ConflictException(
      options.writeConflictMessage ?? '数据已被其他操作修改，请刷新后重试'
    );
  }
}
