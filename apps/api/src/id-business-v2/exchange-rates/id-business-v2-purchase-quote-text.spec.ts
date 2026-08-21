import { describe, expect, it } from 'vitest';
import { renderIdBusinessV2PurchaseQuoteText } from './id-business-v2-purchase-quote-text';

const items = [
  {
    code: 'USD',
    name: '美元',
    quoteUnit: '1',
    purchaseRateFormatted: '5.6000',
    marketRateCapturedAt: new Date('2026-08-20T10:00:00.000Z'),
    stale: false
  },
  {
    code: 'MYR',
    name: '马币',
    quoteUnit: '1',
    purchaseRateFormatted: '1.2345',
    marketRateCapturedAt: new Date('2026-08-20T10:00:00.000Z'),
    stale: false
  }
];

describe('renderIdBusinessV2PurchaseQuoteText', () => {
  it('renders independent currency prices in all three copy formats', () => {
    const generatedAt = new Date('2026-08-20T10:05:00.000Z');
    const wechat = renderIdBusinessV2PurchaseQuoteText({ format: 'wechat', items, generatedAt });
    const monospace = renderIdBusinessV2PurchaseQuoteText({
      format: 'monospace',
      items,
      generatedAt
    });
    const plain = renderIdBusinessV2PurchaseQuoteText({ format: 'plain', items, generatedAt });

    expect(wechat).toContain('美元\u3000ＵＳＤ');
    expect(monospace).toContain('美元 USD');
    expect(plain).toContain('美元 USD：1 USD = ¥5.6000');
    for (const text of [wechat, monospace, plain]) {
      expect(text).toContain('【今日货币人民币收购价】');
      expect(text).toContain('更新时间');
      expect(text).not.toContain('\t');
    }
  });

  it('pads every WeChat label to the same display width before the full-width colon', () => {
    const text = renderIdBusinessV2PurchaseQuoteText({
      format: 'wechat',
      items: [
        ...items,
        {
          code: 'PHP',
          name: '菲律宾比索',
          quoteUnit: '1',
          purchaseRateFormatted: '0.08121',
          marketRateCapturedAt: new Date('2026-08-20T10:00:00.000Z'),
          stale: false
        }
      ],
      generatedAt: new Date('2026-08-20T10:05:00.000Z')
    });
    const labelWidths = text
      .split('\n')
      .filter((line) => line.includes('：1 '))
      .map((line) => displayWidth(line.split('：')[0] ?? ''));

    expect(labelWidths).toHaveLength(3);
    expect(new Set(labelWidths)).toEqual(new Set([20]));
  });

  it('includes a visible stale warning instead of silently presenting old data as current', () => {
    const text = renderIdBusinessV2PurchaseQuoteText({
      format: 'plain',
      items: [{ ...items[0], stale: true }],
      generatedAt: new Date('2026-08-20T10:05:00.000Z')
    });
    expect(text).toContain('汇率数据已超过有效时限');
  });
});

function displayWidth(value: string) {
  return [...value].reduce(
    (width, character) => width + ((character.codePointAt(0) ?? 0) <= 0x7f ? 1 : 2),
    0
  );
}
