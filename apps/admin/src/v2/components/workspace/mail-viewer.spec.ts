import { describe, expect, it } from 'vitest';
import {
  classifyMailQueryCode,
  filterMailViewerMessages,
  mailBodyToPlainText,
  mailBodyParts,
  safeMailLink,
  parseMailQueryCode,
  parseMailQueryCodeLines,
  resolveMailViewerLimit
} from './mail-viewer';

describe('mailBodyToPlainText', () => {
  it('keeps readable content while removing executable and tracking markup', () => {
    const result = mailBodyToPlainText(`
      <style>body { display: none }</style>
      <p>登录验证码：<strong>123456</strong></p>
      <img src="https://tracker.example/pixel" onerror="alert(1)">
      <script>window.stolen = true</script>
      <p><a href="javascript:alert(1)">确认登录</a></p>
    `);

    expect(result).toContain('登录验证码：123456');
    expect(result).toContain('确认登录');
    expect(result).not.toMatch(/script|tracker|javascript|window\.stolen|display: none/i);
  });

  it('normalizes common line breaks and entities', () => {
    expect(mailBodyToPlainText('<div>A&nbsp;&amp;&nbsp;B<br>C</div>')).toBe('A & B\nC');
  });

  it('accepts query-code-only input and normalizes legacy combined credentials', () => {
    expect(parseMailQueryCode(' buyer-code ')).toEqual({ queryCode: 'buyer-code' });
    expect(parseMailQueryCode(' User.Name+tag@GMAIL.com----code----part ')).toEqual({
      queryCode: 'code----part'
    });
    expect(() => parseMailQueryCode('')).toThrow('请输入邮件查询码');
  });

  it('reports invalid and duplicate batch query codes without echoing them', () => {
    const result = parseMailQueryCodeLines(
      ['private-one', 'a'.repeat(65), 'private-one'].join('\n')
    );
    expect(result.items).toHaveLength(1);
    expect(result.errors).toEqual([
      { lineNumber: 2, message: '邮件查询码格式不正确' },
      { lineNumber: 3, message: '邮件查询码重复' }
    ]);
    expect(JSON.stringify(result.errors)).not.toContain('private');
  });

  it('classifies Vendure query codes and fixes buyer results to five messages', () => {
    expect(classifyMailQueryCode('buy-123')).toBe('vendure-virtual');
    expect(classifyMailQueryCode('buyer@example.com----BUY-123')).toBe('vendure-virtual');
    expect(classifyMailQueryCode('MSTR-123')).toBe('vendure-primary');
    expect(classifyMailQueryCode('managed-code')).toBe('managed');
    expect(resolveMailViewerLimit('BUY-123', 20)).toBe(5);
    expect(resolveMailViewerLimit('MSTR-123', 20)).toBe(20);
  });

  it('filters primary-query messages by the selected virtual mailbox', () => {
    const items = [
      { body: '', from: '', savedAt: '', subject: '', to: '', virtualEmailId: 'alias-1' },
      { body: '', from: '', savedAt: '', subject: '', to: '', virtualEmailId: 'alias-2' }
    ];
    expect(filterMailViewerMessages(items, 'alias-1')).toEqual([items[0]]);
    expect(filterMailViewerMessages(items, '')).toEqual(items);
  });
});

describe('mail links', () => {
  it('keeps full query parameters and rejects executable or relative links', () => {
    expect(safeMailLink('https://example.invalid/login?a=1&b=2#continue')).toBe(
      'https://example.invalid/login?a=1&b=2#continue'
    );
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,abc',
      '/admin',
      '//example.invalid',
      'https://user:pass@example.invalid'
    ])
      expect(safeMailLink(url)).toBeUndefined();
  });
  it('makes plain URLs clickable without including trailing punctuation', () => {
    const parts = mailBodyParts('访问 https://example.invalid/path?a=1&b=2。 完成');
    expect(parts.filter((part) => part.href)).toEqual([
      { text: 'https://example.invalid/path?a=1&b=2', href: 'https://example.invalid/path?a=1&b=2' }
    ]);
    expect(parts.map((part) => part.text).join('')).toBe(
      '访问 https://example.invalid/path?a=1&b=2。 完成'
    );
  });
});

it('preserves literal URL query parameters in plain text', () => {
  expect(mailBodyParts('https://example.invalid/?copy=1&not=2')[0]?.href).toBe(
    'https://example.invalid/?copy=1&not=2'
  );
});
