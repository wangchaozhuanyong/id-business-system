import { Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { V2ChangeEventPublisher } from './v2-change-event.publisher';

describe('V2ChangeEventPublisher', () => {
  it('does not query versions when no browser is subscribed', async () => {
    const findMany = vi.fn();
    const publisher = new V2ChangeEventPublisher({
      idBusinessV2ScopeVersion: { findMany }
    } as never);

    await publisher.publishCommittedChange(['orders']);

    expect(findMany).not.toHaveBeenCalled();
  });

  it('publishes only the committed scopes and their current bigint versions', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { scope: 'orders', version: 9007199254740993n },
      { scope: 'customers', version: 12n }
    ]);
    const publisher = new V2ChangeEventPublisher({
      idBusinessV2ScopeVersion: { findMany }
    } as never);
    const eventPromise = firstValueFrom(publisher.events());

    await publisher.publishCommittedChange(['orders', 'orders', 'customers']);

    await expect(eventPromise).resolves.toEqual({
      type: 'change',
      event: expect.objectContaining({
        schemaVersion: 1,
        eventId: expect.any(String),
        occurredAt: expect.any(String),
        scopes: [
          { scope: 'orders', version: '9007199254740993' },
          { scope: 'customers', version: '12' }
        ]
      })
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { scope: { in: ['orders', 'customers'] } },
      select: { scope: true, version: true }
    });
  });

  it('asks connected browsers to reconcile when post-commit publication fails', async () => {
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const publisher = new V2ChangeEventPublisher({
      idBusinessV2ScopeVersion: {
        findMany: vi.fn().mockRejectedValue(new Error('version query failed'))
      }
    } as never);
    const eventPromise = firstValueFrom(publisher.events());

    publisher.publishCommittedChangeBestEffort(['orders']);

    await expect(eventPromise).resolves.toEqual({ type: 'reconcile' });
    expect(logger).toHaveBeenCalledWith({
      event: 'v2_change_event_publish_failed',
      scopes: ['orders']
    });
    logger.mockRestore();
  });
});
