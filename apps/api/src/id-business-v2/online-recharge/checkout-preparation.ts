import { ConflictException } from '@nestjs/common';
import { object } from './validation';

// This is a pre-payment navigation checkpoint, not a payment receipt or quote.
export function checkoutPreparation(value: unknown) {
  const input = object(value);
  const invalid = () => new ConflictException('原结账单准备记录无效，禁止重新建单');
  if (input.state === 'creating') return { state: 'creating' as const };
  if (
    input.state !== 'created' ||
    typeof input.checkoutUrl !== 'string' ||
    input.checkoutUrl.length > 16000
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
  const native =
    url.hostname === 'chatgpt.com'
      ? /^\/checkout\/([a-z][a-z0-9_]{0,40})\/(oaics_[A-Za-z0-9_]{1,200}|cs_(?:live|test)_[A-Za-z0-9]{1,200})\/?$/.exec(
          url.pathname
        )
      : null;
  const hosted = ['checkout.stripe.com', 'pay.openai.com'].includes(url.hostname)
    ? url.pathname.split('/').filter((part) => /^cs_(?:live|test)_[A-Za-z0-9]{1,200}$/.test(part))
    : [];
  if (!native && hosted.length !== 1) throw invalid();
  const checkoutId = native?.[2] || hosted[0];
  let checkoutSource:
    | { kind: 'official_checkout_response'; checkoutId: string; processorEntity: string }
    | undefined;
  if (native && checkoutId.startsWith('cs_')) {
    if (
      !input.checkoutSource ||
      typeof input.checkoutSource !== 'object' ||
      Array.isArray(input.checkoutSource)
    )
      throw invalid();
    const source = object(input.checkoutSource);
    if (
      Object.keys(source).length !== 3 ||
      source.kind !== 'official_checkout_response' ||
      source.checkoutId !== checkoutId ||
      source.processorEntity !== native[1]
    )
      throw invalid();
    checkoutSource = { kind: 'official_checkout_response', checkoutId, processorEntity: native[1] };
  }
  return {
    state: 'created' as const,
    checkoutUrl: url.href,
    sessionId: checkoutId,
    ...(checkoutSource ? { checkoutSource } : {})
  };
}
