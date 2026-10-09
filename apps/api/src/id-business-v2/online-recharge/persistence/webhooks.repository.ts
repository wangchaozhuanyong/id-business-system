import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import { OnlineRechargeRepository } from './online-recharge.repository';
import { OnlineRechargeSettingsService } from '../settings.service';
import { OnlineRechargeAssetsService } from '../assets.service';
import { OnlineRechargeEphemeralCredentials } from '../ephemeral-credentials.service';
import { decryptWebhookCards, verifyWebhook } from '../webhook-crypto';
import { secureEqual } from '../worker.service';
import { object } from '../validation';

@Injectable()
export class OnlineRechargeWebhooksRepository {
  constructor(
    private readonly repository: OnlineRechargeRepository,
    private readonly settings: OnlineRechargeSettingsService,
    private readonly encryption: FieldEncryptionService,
    private readonly assets: OnlineRechargeAssetsService,
    private readonly memory: OnlineRechargeEphemeralCredentials
  ) {}
  async push(token: unknown, input: unknown) {
    const { secrets } = await this.settings.internal();
    if (!secureEqual(token, secrets.externalCardsApiKey))
      throw new UnauthorizedException('补货凭证无效');
    return this.assets.importCards(object(input).cards);
  }
  async receive(
    headers: Record<string, string | string[] | undefined>,
    input: unknown,
    rawBody?: Buffer
  ) {
    const { secrets } = await this.settings.internal();
    const secret = secrets.cardSupplierWebhookSecret;
    if (!secret || !rawBody)
      throw new ServiceUnavailableException('补货回调尚未配置或无法读取原始正文');
    const verified = verifyWebhook(headers, input, rawBody, secret),
      cards = decryptWebhookCards(input, secret);
    const result = await this.repository.transaction('webhook-receive', async (tx) => {
      const prior = await tx.onlineRechargeWebhookReceipt.findFirst({
        where: { OR: [{ eventId: verified.eventId }, { payloadHash: verified.payloadHash }] }
      });
      if (prior) {
        if (prior.eventId === verified.eventId && prior.payloadHash !== verified.payloadHash)
          throw new ConflictException('相同事件编号包含不同正文');
        return {
          duplicate: true,
          count: prior.cardCount,
          cards: [] as { id: string; cvc: string }[]
        };
      }
      const imported: { id: string; cvc: string }[] = [];
      let count = 0;
      for (const card of cards) {
        const numberHash = this.encryption.hash(card.number)!;
        let row = await tx.onlineRechargeCard.findUnique({ where: { numberHash } });
        if (!row) {
          row = await tx.onlineRechargeCard.create({
            data: {
              numberHash,
              numberEncrypted: this.encryption.encrypt(card.number)!,
              last4: card.number.slice(-4),
              expiryMonth: card.expiryMonth,
              expiryYear: card.expiryYear
            }
          });
          count++;
        }
        imported.push({ id: row.id, cvc: card.cvc });
      }
      await tx.onlineRechargeWebhookReceipt.create({
        data: { eventId: verified.eventId, payloadHash: verified.payloadHash, cardCount: count }
      });
      await this.repository.log(tx, 'webhook.receive', undefined, undefined, {
        eventId: verified.eventId,
        count
      });
      return { duplicate: false, count, cards: imported };
    });
    let credentialsAvailable = true;
    try {
      await this.memory.putCards(result.cards);
    } catch {
      credentialsAvailable = false;
    }
    return {
      success: true,
      duplicate: result.duplicate,
      imported: result.count,
      credentialsAvailable
    };
  }
}
