import { describe, expect, it } from 'vitest';
import { mailBodyToPlainText, parseMailQueryCode, parseMailQueryCodeLines } from './mail-viewer';

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
});
