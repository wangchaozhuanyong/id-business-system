import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  parseWebsiteVisitEvent,
  websiteVisitSignaturePayload,
  type WebsiteVisitEvent
} from './id-business-v2-website-visit-input';

export interface WebsiteVisitRequest {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  websiteVisit?: WebsiteVisitEvent;
}

@Injectable()
export class IdBusinessV2WebsiteVisitSignatureGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext) {
    const secret = this.config.get<string>('WEBSITE_VISIT_INGEST_SECRET')?.trim();
    if (!secret || secret.length < 32)
      throw new ServiceUnavailableException('网站访问采集尚未配置');
    const req = context.switchToHttp().getRequest<WebsiteVisitRequest>();
    const signature = req.headers['x-website-visit-signature'];
    if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature))
      throw new UnauthorizedException('访问采集签名无效');
    const event = parseWebsiteVisitEvent(req.body);
    if (Math.abs(Date.now() - Date.parse(event.occurredAt)) > 60_000)
      throw new UnauthorizedException('访问采集签名已过期');
    const expected = createHmac('sha256', secret)
      .update(websiteVisitSignaturePayload(event))
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
      throw new UnauthorizedException('访问采集签名无效');
    req.websiteVisit = event;
    return true;
  }
}
