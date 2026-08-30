import { describe, expect, it, vi } from 'vitest';
import { consumeV2ChangeEventStream, parseSseEvent } from './changeSync';

describe('V2 SSE parser', () => {
  it('parses scope-only change and heartbeat events', () => {
    expect(
      parseSseEvent(
        'id: event-1\nevent: change\ndata: {"schemaVersion":1,"scopes":[{"scope":"orders","version":"9"}]}'
      )
    ).toEqual({
      type: 'change',
      data: {
        schemaVersion: 1,
        scopes: [{ scope: 'orders', version: '9' }]
      }
    });
    expect(parseSseEvent('event: heartbeat\ndata: {"occurredAt":"2026-08-30T00:00:00Z"}')).toEqual({
      type: 'heartbeat',
      data: { occurredAt: '2026-08-30T00:00:00Z' }
    });
  });

  it('rejects unknown event types and malformed JSON', () => {
    expect(parseSseEvent('event: business-row\ndata: {"phone":"13800138000"}')).toBeNull();
    expect(parseSseEvent('event: change\ndata: not-json')).toBeNull();
  });

  it('consumes partial UTF-8 chunks and dispatches only complete events', async () => {
    const encoder = new TextEncoder();
    const onActivity = vi.fn();
    const onEvent = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: snap'));
        controller.enqueue(encoder.encode('shot\ndata: {"schemaVersion":1}\n\n'));
        controller.enqueue(encoder.encode('event: heartbeat\ndata: {}\n\n'));
        controller.close();
      }
    });

    await consumeV2ChangeEventStream(stream, { onActivity, onEvent });

    expect(onEvent).toHaveBeenNthCalledWith(1, 'snapshot', { schemaVersion: 1 });
    expect(onEvent).toHaveBeenNthCalledWith(2, 'heartbeat', {});
    expect(onActivity).toHaveBeenCalledTimes(2);
  });
});
