import { ConflictException } from '@nestjs/common';
import { Amount4 } from '../runtime/public-api';
import { createHash } from 'node:crypto';
import type { OnlineRechargeCheckoutRecovery, OnlineRechargePaymentContext } from './contracts';
import { object } from './validation';

/** Only recover the exact original official Checkout, never an arbitrary worker URL. */
export function checkoutRecovery(value: unknown, context: OnlineRechargePaymentContext) {
  const input = object(value);
  const invalid = () => new ConflictException('原结账单恢复资料与本次付款不一致，禁止提交');
  if (
    input.version !== 1 ||
    typeof input.checkoutId !== 'string' ||
    !/^(?:oaics_[A-Za-z0-9_]{1,200}|cs_(?:live|test)_[A-Za-z0-9]{1,200})$/.test(input.checkoutId) ||
    typeof input.checkoutUrl !== 'string' ||
    input.checkoutUrl.length > 16000 ||
    typeof input.amount !== 'string' ||
    !/^\d{1,14}(\.\d{1,4})?$/.test(input.amount) ||
    !Amount4.from(input.amount).equals(context.amount) ||
    !['kind', 'sourcePlan', 'targetPlan', 'accountId', 'cardId', 'cardLast4', 'currency'].every(
      (key) => input[key] === context[key as keyof OnlineRechargePaymentContext]
    ) ||
    input.quoteId !== context.quoteId ||
    context.quoteId !==
      `quote:${createHash('sha256').update(input.checkoutId).digest('hex').slice(0, 32)}`
  )
    throw invalid();
  let url: URL;
  try {
    url = new URL(input.checkoutUrl);
  } catch {
    throw invalid();
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    throw invalid();
  const native = input.checkoutId.startsWith('oaics_');
  const chatgpt = url.hostname === 'chatgpt.com';
  let source: OnlineRechargeCheckoutRecovery['source'];
  if (native || chatgpt) {
    if (
      typeof input.processorEntity !== 'string' ||
      !/^[a-z][a-z0-9_]{0,40}$/.test(input.processorEntity) ||
      url.hostname !== 'chatgpt.com' ||
      url.pathname.replace(/\/$/, '') !== `/checkout/${input.processorEntity}/${input.checkoutId}`
    )
      throw invalid();
    if (!native) {
      // A cs_* path alone can be fabricated by the old fallback resolver. The
      // trusted worker must also supply the matching official response fields.
      const value = input.source;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
      const response = value as Record<string, unknown>;
      if (
        Object.keys(response).length !== 3 ||
        response.kind !== 'official_checkout_response' ||
        response.checkoutId !== input.checkoutId ||
        response.processorEntity !== input.processorEntity
      )
        throw invalid();
      source = {
        kind: 'official_checkout_response',
        checkoutId: input.checkoutId,
        processorEntity: input.processorEntity
      };
    }
  } else if (
    input.processorEntity !== null ||
    !['checkout.stripe.com', 'pay.openai.com'].includes(url.hostname) ||
    url.pathname.split('/').filter((part) => /^cs_(?:live|test)_[A-Za-z0-9]{1,200}$/.test(part))
      .length !== 1 ||
    !url.pathname.split('/').includes(input.checkoutId)
  )
    throw invalid();
  return {
    ...context,
    version: 1,
    checkoutId: input.checkoutId,
    processorEntity: native || chatgpt ? input.processorEntity : null,
    checkoutUrl: input.checkoutUrl,
    quoteId: context.quoteId,
    ...(source ? { source } : {})
  } as OnlineRechargeCheckoutRecovery;
}
