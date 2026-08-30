import { Injectable, type MessageEvent } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  V2_DATA_SCOPES,
  isV2DataScope,
  type V2ChangeVersionsResult,
  type V2ChangeEvent,
  type V2DataScope
} from '@apple-business/shared';
import { Observable } from 'rxjs';
import { V2ChangeEventPublisher } from '../../common/prisma/v2-change-event.publisher';
import { IdBusinessV2ChangeSyncRepository } from './persistence/id-business-v2-change-sync.repository';

@Injectable()
export class IdBusinessV2ChangeSyncService {
  private static readonly HEARTBEAT_INTERVAL_MS = 25_000;

  constructor(
    private readonly repository: IdBusinessV2ChangeSyncRepository,
    private readonly changeEventPublisher: V2ChangeEventPublisher
  ) {}

  async getVersions(): Promise<V2ChangeVersionsResult> {
    const records = await this.repository.listScopeVersions();
    const versions = Object.fromEntries(V2_DATA_SCOPES.map((scope) => [scope, '0'])) as Record<
      V2DataScope,
      string
    >;

    for (const record of records) {
      if (isV2DataScope(record.scope)) {
        versions[record.scope] = record.version;
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      versions
    };
  }

  streamEvents() {
    return new Observable<MessageEvent>((subscriber) => {
      let closed = false;
      const liveSubscription = this.changeEventPublisher.events().subscribe({
        next: (message) => {
          if (message.type === 'reconcile') {
            subscriber.error(new Error('实时事件发布失败，请重新连接并核对版本。'));
            return;
          }
          subscriber.next(this.toMessageEvent('change', message.event));
        },
        error: (error) => subscriber.error(error)
      });
      const heartbeatTimer = setInterval(() => {
        subscriber.next({
          type: 'heartbeat',
          data: { occurredAt: new Date().toISOString() }
        });
      }, IdBusinessV2ChangeSyncService.HEARTBEAT_INTERVAL_MS);

      void this.createSnapshotEvent()
        .then((event) => {
          if (!closed) subscriber.next(this.toMessageEvent('snapshot', event));
        })
        .catch((error: unknown) => {
          if (!closed) subscriber.error(error);
        });

      return () => {
        closed = true;
        clearInterval(heartbeatTimer);
        liveSubscription.unsubscribe();
      };
    });
  }

  private async createSnapshotEvent(): Promise<V2ChangeEvent> {
    const result = await this.getVersions();
    return {
      schemaVersion: 1,
      eventId: randomUUID(),
      occurredAt: result.generatedAt,
      scopes: V2_DATA_SCOPES.map((scope) => ({ scope, version: result.versions[scope] }))
    };
  }

  private toMessageEvent(type: 'change' | 'snapshot', event: V2ChangeEvent): MessageEvent {
    return {
      type,
      id: event.eventId,
      retry: 1_000,
      data: event
    };
  }
}
