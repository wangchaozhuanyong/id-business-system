import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

const MAX_RATE_LIMIT_KEYS = 20_000;
const MAX_AUTHORIZATIONS = 1_000;
const AUTHORIZATION_RESULT_RETENTION_MS = 30 * 60 * 1000;
const AUTHORIZATION_PROCESSING_TIMEOUT_MS = 2 * 60 * 1000;

type TransientAuthorizationStatus = 'pending' | 'processing' | 'succeeded' | 'failed';

interface RateLimitWindow {
  timestamps: number[];
}

export interface TransientMailboxAuthorization {
  id: string;
  stateHash: string;
  email: string;
  label: string | null;
  status: TransientAuthorizationStatus;
  failureCode: string | null;
  mailboxId: string | null;
  createdByUserId: string;
  expiresAt: Date;
  completedAt: Date | null;
  processingStartedAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class IdBusinessV2MailboxTransientStateService {
  private readonly rateLimitWindows = new Map<string, RateLimitWindow>();
  private readonly authorizations = new Map<string, TransientMailboxAuthorization>();
  private readonly authorizationIdsByStateHash = new Map<string, string>();

  reservePublicQuery(input: {
    queryCodeHash: string;
    ipHash: string | null;
    now?: Date;
    windowMs: number;
    maxQueryCodeAttempts: number;
    maxIpAttempts: number;
  }) {
    const now = input.now?.getTime() ?? Date.now();
    const cutoff = now - input.windowMs;
    const queryCodeKey = `query-code:${input.queryCodeHash}`;
    const ipKey = input.ipHash ? `ip:${input.ipHash}` : null;

    this.pruneRateLimitWindows(cutoff);
    const newKeyCount =
      Number(!this.rateLimitWindows.has(queryCodeKey)) +
      Number(Boolean(ipKey && !this.rateLimitWindows.has(ipKey)));
    if (this.rateLimitWindows.size + newKeyCount > MAX_RATE_LIMIT_KEYS) return false;

    const queryCodeAttempts = this.activeTimestamps(queryCodeKey, cutoff);
    const ipAttempts = ipKey ? this.activeTimestamps(ipKey, cutoff) : [];
    if (
      queryCodeAttempts.length >= input.maxQueryCodeAttempts ||
      ipAttempts.length >= input.maxIpAttempts
    ) {
      return false;
    }

    queryCodeAttempts.push(now);
    this.rateLimitWindows.set(queryCodeKey, { timestamps: queryCodeAttempts });
    if (ipKey) {
      ipAttempts.push(now);
      this.rateLimitWindows.set(ipKey, { timestamps: ipAttempts });
    }
    return true;
  }

  createAuthorization(input: {
    stateHash: string;
    email: string;
    label: string | null;
    mailboxId: string | null;
    createdByUserId: string;
    expiresAt: Date;
  }) {
    const now = new Date();
    this.pruneAuthorizations(now);
    if (this.authorizations.size >= MAX_AUTHORIZATIONS) return null;

    const authorization: TransientMailboxAuthorization = {
      id: randomUUID(),
      ...input,
      status: 'pending',
      failureCode: null,
      completedAt: null,
      processingStartedAt: null,
      createdAt: now
    };
    this.authorizations.set(authorization.id, authorization);
    this.authorizationIdsByStateHash.set(authorization.stateHash, authorization.id);
    return this.cloneAuthorization(authorization);
  }

  findAuthorizationById(id: string) {
    const now = new Date();
    this.pruneAuthorizations(now);
    const authorization = this.authorizations.get(id);
    return authorization ? this.cloneAuthorization(authorization) : null;
  }

  claimPendingAuthorization(stateHash: string) {
    const now = new Date();
    this.pruneAuthorizations(now);
    const id = this.authorizationIdsByStateHash.get(stateHash);
    const authorization = id ? this.authorizations.get(id) : undefined;
    if (!authorization || authorization.status !== 'pending') return null;
    if (authorization.expiresAt.getTime() <= now.getTime()) {
      this.failAuthorization(authorization.id, 'expired', now);
      return null;
    }

    authorization.status = 'processing';
    authorization.processingStartedAt = now;
    return this.cloneAuthorization(authorization);
  }

  succeedAuthorization(id: string, mailboxId: string, completedAt = new Date()) {
    const authorization = this.authorizations.get(id);
    if (!authorization || authorization.status !== 'processing') return false;
    authorization.status = 'succeeded';
    authorization.failureCode = null;
    authorization.mailboxId = mailboxId;
    authorization.completedAt = completedAt;
    authorization.processingStartedAt = null;
    return true;
  }

  failAuthorization(id: string, failureCode: string, completedAt = new Date()) {
    const authorization = this.authorizations.get(id);
    if (
      !authorization ||
      authorization.status === 'succeeded' ||
      authorization.status === 'failed'
    ) {
      return false;
    }
    authorization.status = 'failed';
    authorization.failureCode = failureCode;
    authorization.completedAt = completedAt;
    authorization.processingStartedAt = null;
    return true;
  }

  private activeTimestamps(key: string, cutoff: number) {
    return (this.rateLimitWindows.get(key)?.timestamps ?? []).filter(
      (timestamp) => timestamp >= cutoff
    );
  }

  private pruneRateLimitWindows(cutoff: number) {
    for (const [key, window] of this.rateLimitWindows) {
      const timestamps = window.timestamps.filter((timestamp) => timestamp >= cutoff);
      if (timestamps.length > 0) {
        window.timestamps = timestamps;
      } else {
        this.rateLimitWindows.delete(key);
      }
    }
  }

  private pruneAuthorizations(now: Date) {
    const nowMs = now.getTime();
    for (const authorization of this.authorizations.values()) {
      if (authorization.status === 'pending' && authorization.expiresAt.getTime() <= nowMs) {
        this.failAuthorization(authorization.id, 'expired', now);
      } else if (
        authorization.status === 'processing' &&
        authorization.processingStartedAt &&
        authorization.processingStartedAt.getTime() + AUTHORIZATION_PROCESSING_TIMEOUT_MS <= nowMs
      ) {
        this.failAuthorization(authorization.id, 'completion_failed', now);
      }

      const completedAtMs = authorization.completedAt?.getTime();
      if (completedAtMs && completedAtMs + AUTHORIZATION_RESULT_RETENTION_MS <= nowMs) {
        this.authorizations.delete(authorization.id);
        this.authorizationIdsByStateHash.delete(authorization.stateHash);
      }
    }
  }

  private cloneAuthorization(authorization: TransientMailboxAuthorization) {
    return {
      ...authorization,
      expiresAt: new Date(authorization.expiresAt),
      completedAt: authorization.completedAt ? new Date(authorization.completedAt) : null,
      processingStartedAt: authorization.processingStartedAt
        ? new Date(authorization.processingStartedAt)
        : null,
      createdAt: new Date(authorization.createdAt)
    };
  }
}
