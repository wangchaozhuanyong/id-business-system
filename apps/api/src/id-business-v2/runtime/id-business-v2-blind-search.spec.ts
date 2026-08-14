import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildIdBusinessV2BlindIndexTokens,
  buildIdBusinessV2BlindQueryTokens,
  matchesIdBusinessV2BlindSearch,
  normalizeIdBusinessV2BlindSearchText
} from './id-business-v2-blind-search';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('ID 业务敏感字段盲索引', () => {
  it('统一大小写和全角字符后生成二元及三元令牌', () => {
    const tokens = buildIdBusinessV2BlindIndexTokens(' ７２8User@Example.COM ', 'apple-id', hash);

    expect(normalizeIdBusinessV2BlindSearchText(' ７２8User@Example.COM ')).toBe(
      '728user@example.com'
    );
    expect(tokens).toContain(hash('v1:apple-id:2:72'));
    expect(tokens).toContain(hash('v1:apple-id:3:728'));
    expect(tokens).toContain(hash('v1:apple-id:3:use'));
  });

  it('查询只生成最强可用分词并按字段命名空间隔离', () => {
    expect(buildIdBusinessV2BlindQueryTokens('72', 'apple-id', hash)).toEqual([
      hash('v1:apple-id:2:72')
    ]);
    expect(buildIdBusinessV2BlindQueryTokens('7284', 'apple-id', hash)).toEqual(
      [hash('v1:apple-id:3:728'), hash('v1:apple-id:3:284')].sort()
    );
    expect(buildIdBusinessV2BlindQueryTokens('728', 'website-account', hash)).not.toEqual(
      buildIdBusinessV2BlindQueryTokens('728', 'apple-id', hash)
    );
  });

  it('为极短历史值生成完整值令牌，避免回填时仍被视为空索引', () => {
    expect(buildIdBusinessV2BlindIndexTokens('8', 'website-account', hash)).toEqual([
      hash('v1:website-account:value:8')
    ]);
    expect(buildIdBusinessV2BlindIndexTokens('', 'website-account', hash)).toEqual([]);
  });

  it('由解密值复核连续片段，过滤分词碰撞和不连续误命中', () => {
    expect(matchesIdBusinessV2BlindSearch('user72845@example.com', '728')).toBe(true);
    expect(matchesIdBusinessV2BlindSearch('user72x28@example.com', '728')).toBe(false);
  });

  it.each([
    ['account-phone', '+1 415 728 4500', '728'],
    ['customer-phone', '13800138000', '1380'],
    ['customer-wechat', 'wechat_user_728', 'user'],
    ['customer-qq', '72845001', '845'],
    ['customer-whatsapp', '+63 917 728 4500', '917'],
    ['gift-card-code', 'X9AB-7284-CD56', '7284']
  ] as const)('保证 %s 脱敏字段仍可按片段查询', (namespace, value, query) => {
    const indexTokens = buildIdBusinessV2BlindIndexTokens(value, namespace, hash);
    const queryTokens = buildIdBusinessV2BlindQueryTokens(query, namespace, hash);

    expect(queryTokens.length).toBeGreaterThan(0);
    expect(indexTokens).toEqual(expect.arrayContaining(queryTokens));
    expect(indexTokens.join('')).not.toContain(value.toLowerCase());
  });
});
