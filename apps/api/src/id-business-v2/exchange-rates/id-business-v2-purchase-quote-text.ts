export const ID_BUSINESS_V2_PURCHASE_QUOTE_TEXT_FORMATS = ['wechat', 'monospace', 'plain'] as const;

export type IdBusinessV2PurchaseQuoteTextFormat =
  (typeof ID_BUSINESS_V2_PURCHASE_QUOTE_TEXT_FORMATS)[number];

export interface IdBusinessV2PurchaseQuoteTextItem {
  code: string;
  name: string;
  quoteUnit: string;
  purchaseRateFormatted: string;
  marketRateCapturedAt: Date;
  stale: boolean;
}

export function renderIdBusinessV2PurchaseQuoteText(input: {
  format: IdBusinessV2PurchaseQuoteTextFormat;
  items: IdBusinessV2PurchaseQuoteTextItem[];
  generatedAt: Date;
}) {
  if (input.items.length === 0) throw new Error('没有可生成文本的收购报价');
  const rateCapturedAt = new Date(
    Math.min(...input.items.map((item) => item.marketRateCapturedAt.getTime()))
  );
  const stale = input.items.some((item) => item.stale);
  const title = '今日货币人民币收购价';
  const warning = stale ? ['⚠ 汇率数据已超过有效时限，请先刷新后再发送'] : [];
  const footer = `更新时间：${formatBusinessDateTime(rateCapturedAt)}`;

  if (input.format === 'wechat') {
    const targetWidth = Math.max(
      20,
      ...input.items.map((item) => displayWidth(createWechatLabel(item.name, item.code)))
    );
    return [
      `【${title}】`,
      ...warning,
      '',
      ...input.items.map(
        (item) =>
          `${padByDisplayWidth(createWechatLabel(item.name, item.code), targetWidth, '\u3000')}：${item.quoteUnit} ${item.code} = ¥${item.purchaseRateFormatted}`
      ),
      '',
      footer
    ].join('\n');
  }

  if (input.format === 'monospace') {
    const targetWidth = Math.max(
      20,
      ...input.items.map((item) => displayWidth(`${item.name} ${item.code}`))
    );
    return [
      `【${title}】`,
      ...warning,
      '',
      ...input.items.map(
        (item) =>
          `${padByDisplayWidth(`${item.name} ${item.code}`, targetWidth, ' ')}：${item.quoteUnit} ${item.code} = ¥${item.purchaseRateFormatted}`
      ),
      '',
      footer
    ].join('\n');
  }

  return [
    `【${title}】`,
    ...warning,
    '',
    ...input.items.map(
      (item) =>
        `${item.name} ${item.code}：${item.quoteUnit} ${item.code} = ¥${item.purchaseRateFormatted}`
    ),
    '',
    footer
  ].join('\n');
}

function createWechatLabel(name: string, code: string) {
  return `${toFullWidthAscii(name)}\u3000${toFullWidthAscii(code)}`;
}

function padByDisplayWidth(input: string, targetWidth: number, padding: ' ' | '\u3000') {
  let output = input;
  while (displayWidth(output) < targetWidth) output += padding;
  return output;
}

function displayWidth(value: string) {
  return [...value].reduce((width, character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return width + (codePoint <= 0x7f ? 1 : 2);
  }, 0);
}

function toFullWidthAscii(value: string) {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x21 && codePoint <= 0x7e
        ? String.fromCodePoint(codePoint + 0xfee0)
        : character;
    })
    .join('');
}

function formatBusinessDateTime(value: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
    .format(value)
    .replaceAll('/', '-');
}
