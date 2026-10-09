// Adapted from PAY-GPT-UPGRADE ba6cf963 card-supplier-webhook.js (MIT).
import { BadRequestException } from '@nestjs/common';
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { object, text } from './validation';

export function verifyWebhook(
  headers: Record<string, string | string[] | undefined>,
  payload: unknown,
  rawBody: Buffer,
  secret: string
) {
  const body = object(payload),
    eventId = text(body.eventId, '事件编号', 190),
    eventType = text(body.eventType, '事件类型', 100);
  const header = (key: string) =>
    typeof headers[key] === 'string' ? (headers[key] as string).trim() : '';
  const timestamp = header('x-vcc-webhook-timestamp'),
    nonce = header('x-vcc-webhook-nonce'),
    signature = header('x-vcc-webhook-signature').toLowerCase();
  if (
    header('x-vcc-webhook-id') !== eventId ||
    header('x-vcc-webhook-event') !== eventType ||
    !/^\d+$/.test(timestamp) ||
    !nonce ||
    !/^v1=[a-f0-9]{64}$/.test(signature) ||
    !rawBody.length
  )
    throw new BadRequestException('补货事件签名字段无效');
  const payloadHash = createHash('sha256').update(rawBody).digest('hex');
  const expected = `v1=${createHmac('sha256', secret).update([eventId, eventType, timestamp, nonce, payloadHash].join('\n')).digest('hex')}`;
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    throw new BadRequestException('补货事件签名验证失败');
  return { eventId, eventType, payloadHash };
}
export function decryptWebhookCards(payload: unknown, secret: string) {
  const body = object(payload);
  if (body.eventType !== 'CARD_ISSUE.SUCCESS') return [];
  const values = object(body.data).cards;
  if (!Array.isArray(values) || !values.length || values.length > 500)
    throw new BadRequestException('补货事件须包含1至500张卡');
  const key = createHmac('sha256', secret).update('vcc-webhook-sensitive-v1').digest();
  const decrypt = (value: unknown) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new BadRequestException('补货密文格式无效');
    const packed = Buffer.from(value, 'base64url');
    if (packed.length < 29) throw new BadRequestException('补货密文长度无效');
    try {
      const cipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
      cipher.setAuthTag(packed.subarray(-16));
      return Buffer.concat([cipher.update(packed.subarray(12, -16)), cipher.final()])
        .toString('utf8')
        .trim();
    } catch {
      throw new BadRequestException('补货密文无法解密');
    }
  };
  return values.map((value) => {
    const card = object(value),
      number = decrypt(card.cardNumberCiphertext).replace(/[\s-]/g, ''),
      expiry = decrypt(card.expiryDateCiphertext),
      cvc = decrypt(card.cvvCiphertext);
    if (!/^\d{13,19}$/.test(number) || !/^\d{3,4}$/.test(cvc))
      throw new BadRequestException('补货卡片格式无效');
    const match = expiry.match(/^(\d{2})\/(\d{2}|\d{4})$/),
      reversed = expiry.match(/^(\d{4})-(\d{2})$/);
    if (!match && !reversed) throw new BadRequestException('补货有效期格式无效');
    const expiryMonth = Number(match?.[1] ?? reversed![2]);
    let expiryYear = Number(match?.[2] ?? reversed![1]);
    if (expiryYear < 100) expiryYear += 2000;
    if (expiryMonth < 1 || expiryMonth > 12) throw new BadRequestException('补货有效月份无效');
    return { number, expiryMonth, expiryYear, cvc };
  });
}
