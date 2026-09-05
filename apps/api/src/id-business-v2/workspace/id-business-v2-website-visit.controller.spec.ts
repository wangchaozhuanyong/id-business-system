import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { IS_PUBLIC_KEY, REQUIRED_ROLES_KEY } from '../../auth/auth.decorators';
import { IdBusinessV2WebsiteVisitSignatureGuard } from './id-business-v2-website-visit-signature.guard';
import { IdBusinessV2WebsiteVisitController } from './id-business-v2-website-visit.controller';

describe('website visit controller', () => {
  it('keeps only signed ingestion public and requires admin for search and reveal', () => {
    const prototype = IdBusinessV2WebsiteVisitController.prototype;

    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.ingest)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, prototype.ingest)).toContain(
      IdBusinessV2WebsiteVisitSignatureGuard
    );
    expect(Reflect.getMetadata(REQUIRED_ROLES_KEY, prototype.search)).toEqual(['admin']);
    expect(Reflect.getMetadata(REQUIRED_ROLES_KEY, prototype.reveal)).toEqual(['admin']);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.search)).toBeUndefined();
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.reveal)).toBeUndefined();
  });

  it('passes only the request data selected by the signature guard to ingestion', async () => {
    const event = {
      eventId: '4f7989c2-b347-41f5-98e5-09a74ce303d4',
      host: 'flashcast.com.my',
      path: '/zh',
      ip: '203.0.113.19',
      occurredAt: '2026-09-06T01:02:03.004Z'
    };
    const service = { ingest: vi.fn().mockResolvedValue({ accepted: true }) };
    const controller = new IdBusinessV2WebsiteVisitController(service as never);

    await expect(
      controller.ingest({ body: { untrusted: true }, headers: {}, websiteVisit: event })
    ).resolves.toEqual({ accepted: true });
    expect(service.ingest).toHaveBeenCalledWith(event);
  });
});
