import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { OnlineRechargeWebhooksRepository } from './persistence/webhooks.repository';
import { object } from './validation';

@Injectable()
export class OnlineRechargeWebhooksService {
  constructor(private readonly webhooks: OnlineRechargeWebhooksRepository) {}
  push(token: unknown, raw: unknown) {
    return this.webhooks.push(token, object(raw));
  }
  receive(headers: Record<string, string | string[] | undefined>, raw: unknown, rawBody?: Buffer) {
    if (!rawBody) throw new ServiceUnavailableException('补货事件必须提供原始正文');
    return this.webhooks.receive(headers, object(raw), rawBody);
  }
}
