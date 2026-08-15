import { describe, expect, it } from 'vitest';
import { mailBodyToPlainText, parseMailCredential, parseMailCredentialLines } from './mail-viewer';

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

  it('parses generic email credentials and keeps separators inside the query code', () => {
    expect(parseMailCredential(' User.Name+tag@GMAIL.com----code----part ')).toEqual({
      credential: 'user.name+tag@gmail.com----code----part',
      email: 'user.name+tag@gmail.com',
      queryCode: 'code----part'
    });
    expect(() => parseMailCredential('user@gmail.com')).toThrow(
      '格式不正确，请输入 邮箱----邮件查询码'
    );
  });

  it('reports invalid and duplicate batch lines without echoing query codes', () => {
    const result = parseMailCredentialLines(
      ['first@gmail.com----private-one', 'bad-line', 'first@gmail.com----private-two'].join('\n')
    );
    expect(result.items).toHaveLength(1);
    expect(result.errors).toEqual([
      { lineNumber: 2, message: '格式不正确，请输入 邮箱----邮件查询码' },
      { lineNumber: 3, message: '邮箱重复' }
    ]);
    expect(JSON.stringify(result.errors)).not.toContain('private');
  });
});
