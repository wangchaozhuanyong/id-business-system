import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';

@Injectable()
export class OnlineRechargeEphemeralCredentials {
  private readonly tickets = new Map<string, { taskId: string; expiresAt: number }>();
  constructor(private readonly config: ConfigService) {}
  async putCvc(cardId: string, value: unknown) {
    if (typeof value !== 'string' || !/^\d{3,4}$/.test(value))
      throw new BadRequestException('安全码须为3至4位数字');
    await this.request('/credentials', { cards: [{ id: cardId, cvc: value }] });
  }
  async putCards(cards: { id: string; cvc: string }[]) {
    if (!cards.length) return;
    if (cards.length > 500 || cards.some((card) => !/^\d{3,4}$/.test(card.cvc)))
      throw new BadRequestException('安全码批量格式无效');
    await this.request('/credentials', { cards });
  }
  async available(ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    try {
      const result = (await this.request('/credentials/status', { ids })) as {
        availableIds?: string[];
      };
      return result.availableIds ?? [];
    } catch {
      return [];
    }
  }
  async forgetCvc(cardId: string) {
    try {
      await this.request('/credentials/forget', { ids: [cardId] });
    } catch {
      /* Worker memory expires independently. */
    }
  }
  ticket(taskId: string) {
    this.prune();
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, { taskId, expiresAt: Date.now() + 60000 });
    return { ticket, wsPath: '/api/id-business-v2/online-recharge/ws', expiresIn: 60 };
  }
  redeemTicket(ticket: string) {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return entry && entry.expiresAt > Date.now() ? entry.taskId : null;
  }
  private prune() {
    const now = Date.now();
    for (const [key, entry] of this.tickets) if (entry.expiresAt <= now) this.tickets.delete(key);
  }
  private async request(path: string, body: unknown) {
    const base = this.config.get<string>('ONLINE_RECHARGE_CREDENTIALS_URL');
    const key = this.config.get<string>('ONLINE_RECHARGE_WORKER_KEY');
    if (!base || !key || key.length < 32)
      throw new ServiceUnavailableException('执行器临时凭据通道未配置，安全码未保存');
    let url: URL;
    try {
      url = new URL(path, base);
    } catch {
      throw new ServiceUnavailableException('执行器临时凭据通道配置无效');
    }
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    )
      throw new ServiceUnavailableException('临时凭据通道必须使用本机或加密连接');
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-online-recharge-worker': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
        redirect: 'error'
      });
      if (!response.ok) throw new Error('credentials unavailable');
      return (await response.json()) as unknown;
    } catch {
      throw new ServiceUnavailableException(
        '执行器临时凭据通道不可用，安全码未保存，请启动执行器后重新补充'
      );
    }
  }
}
