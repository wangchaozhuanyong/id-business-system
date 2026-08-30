import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  isV2DataScope,
  type V2ChangeEvent,
  type V2DataScope,
  type V2ScopeVersion
} from '@apple-business/shared';
import { Observable, Subject } from 'rxjs';
import { PrismaService } from './prisma.service';

export type V2ChangePublisherMessage =
  | { type: 'change'; event: V2ChangeEvent }
  | { type: 'reconcile' };

@Injectable()
export class V2ChangeEventPublisher {
  private readonly logger = new Logger(V2ChangeEventPublisher.name);
  private readonly committedChanges = new Subject<V2ChangePublisherMessage>();
  private subscriberCount = 0;

  constructor(private readonly prisma: PrismaService) {}

  events() {
    return new Observable<V2ChangePublisherMessage>((subscriber) => {
      this.subscriberCount += 1;
      const subscription = this.committedChanges.subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
        this.subscriberCount = Math.max(0, this.subscriberCount - 1);
      };
    });
  }

  publishCommittedChangeBestEffort(scopes: readonly V2DataScope[]) {
    void this.publishCommittedChange(scopes).catch(() => {
      this.logger.error({
        event: 'v2_change_event_publish_failed',
        scopes
      });
      if (this.subscriberCount > 0) {
        this.committedChanges.next({ type: 'reconcile' });
      }
    });
  }

  async publishCommittedChange(scopes: readonly V2DataScope[]) {
    if (this.subscriberCount === 0) return;

    const uniqueScopes = [...new Set(scopes)];
    if (!uniqueScopes.length) return;

    const rows = await this.prisma.idBusinessV2ScopeVersion.findMany({
      where: { scope: { in: uniqueScopes } },
      select: { scope: true, version: true }
    });
    const versionByScope = new Map(
      rows
        .filter((row) => isV2DataScope(row.scope))
        .map((row) => [row.scope, row.version.toString()] as const)
    );
    const changedScopes = uniqueScopes.map<V2ScopeVersion>((scope) => ({
      scope,
      version: versionByScope.get(scope) ?? '0'
    }));

    this.committedChanges.next({
      type: 'change',
      event: {
        schemaVersion: 1,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        scopes: changedScopes
      }
    });
  }
}
