import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import type { OnlineRechargeAssetsService } from '../assets.service';
import type { OnlineRechargeEphemeralCredentials } from '../ephemeral-credentials.service';
import type { OnlineRechargeSettingsService } from '../settings.service';
import type { OnlineRechargeRepository } from './online-recharge.repository';
import { OnlineRechargeWebhooksRepository } from './webhooks.repository';

const secret = 'synthetic-webhook-fixture-only';
function signedPayload(eventId = randomUUID(), cvc = '123') {
  const key = createHmac('sha256', secret).update('vcc-webhook-sensitive-v1').digest();
  const encrypt = (value: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString(
      'base64url'
    );
  };
  const body = {
    eventId,
    eventType: 'CARD_ISSUE.SUCCESS',
    data: {
      cards: [
        {
          cardNumberCiphertext: encrypt('4242424242424242'),
          expiryDateCiphertext: encrypt('12/2030'),
          cvvCiphertext: encrypt(cvc)
        }
      ]
    }
  };
  const raw = Buffer.from(JSON.stringify(body));
  const hash = createHash('sha256').update(raw).digest('hex');
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const signature = createHmac('sha256', secret)
    .update([eventId, body.eventType, timestamp, nonce, hash].join('\n'))
    .digest('hex');
  return {
    body,
    raw,
    headers: {
      'x-vcc-webhook-id': eventId,
      'x-vcc-webhook-event': body.eventType,
      'x-vcc-webhook-timestamp': timestamp,
      'x-vcc-webhook-nonce': nonce,
      'x-vcc-webhook-signature': `v1=${signature}`
    }
  };
}

function fixture() {
  let card: Record<string, unknown> | null = null;
  let receipt: Record<string, unknown> | null = null;
  const tx = {
    onlineRechargeWebhookReceipt: {
      findFirst: vi.fn(async () => receipt),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        receipt = { id: randomUUID(), ...data };
        return receipt;
      })
    },
    onlineRechargeCard: {
      findUnique: vi.fn(async () => card),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        card = { id: randomUUID(), ...data };
        return card;
      })
    }
  };
  const repository = {
    transaction: vi.fn(async (_key: string, work: (tx: V2CommandTransaction) => unknown) =>
      work(tx as unknown as V2CommandTransaction)
    ),
    log: vi.fn(async () => undefined)
  };
  const memory = {
    putCards: vi
      .fn<(cards: { id: string; cvc: string }[]) => Promise<void>>()
      .mockResolvedValue(undefined)
  };
  const hooks = new OnlineRechargeWebhooksRepository(
    repository as unknown as OnlineRechargeRepository,
    {
      internal: async () => ({ secrets: { cardSupplierWebhookSecret: secret } })
    } as unknown as OnlineRechargeSettingsService,
    new FieldEncryptionService(new ConfigService({ FIELD_ENCRYPTION_KEY: 'synthetic-field-key' })),
    {} as OnlineRechargeAssetsService,
    memory as unknown as OnlineRechargeEphemeralCredentials
  );
  const receive = (payload: ReturnType<typeof signedPayload>) =>
    hooks.receive(payload.headers, payload.body, payload.raw);
  return { tx, memory, hooks, receive, removeCard: () => (card = null) };
}

describe('已验签补货事件的临时安全码重交付', () => {
  it('首回交付失败后重复正文重新交付，不重复入库卡片或回执', async () => {
    const f = fixture();
    const payload = signedPayload();
    f.memory.putCards.mockRejectedValueOnce(new Error('synthetic credentials offline'));
    await expect(f.receive(payload)).resolves.toMatchObject({
      imported: 1,
      duplicate: false,
      credentialsAvailable: false
    });
    await expect(f.receive(payload)).resolves.toMatchObject({
      imported: 1,
      duplicate: true,
      credentialsAvailable: true
    });
    expect(f.memory.putCards).toHaveBeenCalledTimes(2);
    expect(f.memory.putCards.mock.calls[1]![0]).toEqual(f.memory.putCards.mock.calls[0]![0]);
    expect(f.tx.onlineRechargeCard.create).toHaveBeenCalledTimes(1);
    expect(f.tx.onlineRechargeWebhookReceipt.create).toHaveBeenCalledTimes(1);
    expect(f.tx.onlineRechargeCard.create.mock.calls[0]![0].data).not.toHaveProperty('cvc');
    expect(f.tx.onlineRechargeWebhookReceipt.create.mock.calls[0]![0].data).not.toHaveProperty(
      'cvc'
    );
  });

  it('重复事件通道仍失败时仍返回不可用', async () => {
    const f = fixture();
    f.memory.putCards.mockRejectedValue(new Error('synthetic credentials offline'));
    const payload = signedPayload();
    await f.receive(payload);
    await expect(f.receive(payload)).resolves.toMatchObject({
      duplicate: true,
      credentialsAvailable: false
    });
    expect(f.memory.putCards).toHaveBeenCalledTimes(2);
  });

  it('重复事件中的卡片已不存在时不补建，也不声称安全码可用', async () => {
    const f = fixture();
    const payload = signedPayload();
    await f.receive(payload);
    f.removeCard();
    await expect(f.receive(payload)).resolves.toMatchObject({
      duplicate: true,
      credentialsAvailable: false
    });
    expect(f.tx.onlineRechargeCard.create).toHaveBeenCalledTimes(1);
    expect(f.memory.putCards.mock.calls[1]![0]).toEqual([]);
  });

  it('相同事件编号更换正文即使重新正确签名，也不能覆盖或交付另一安全码', async () => {
    const f = fixture();
    const payload = signedPayload();
    await f.receive(payload);
    await expect(f.receive(signedPayload(payload.body.eventId, '456'))).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(f.memory.putCards).toHaveBeenCalledTimes(1);
    expect(f.tx.onlineRechargeCard.create).toHaveBeenCalledTimes(1);
  });

  it('错误签名不读取或交付卡片', async () => {
    const f = fixture();
    const payload = signedPayload();
    payload.headers['x-vcc-webhook-signature'] = `v1=${'0'.repeat(64)}`;
    await expect(f.receive(payload)).rejects.toThrow('签名验证失败');
    expect(f.tx.onlineRechargeWebhookReceipt.findFirst).not.toHaveBeenCalled();
    expect(f.memory.putCards).not.toHaveBeenCalled();
  });
});
