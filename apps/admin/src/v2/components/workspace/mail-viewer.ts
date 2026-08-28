import { V2_MAIL_VIEWER_LIMITS } from '@apple-business/shared';

const CREDENTIAL_SEPARATOR = '----';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REMOVED_ELEMENTS =
  'script, style, noscript, iframe, object, embed, svg, canvas, form, input, button, video, audio, source, picture, img, link, meta';
const BLOCK_ELEMENTS =
  'p, div, section, article, header, footer, li, tr, table, h1, h2, h3, h4, h5, h6';

export interface ParsedMailQueryCode {
  queryCode: string;
}

export interface MailQueryCodeLineError {
  lineNumber: number;
  message: string;
}

export function parseMailQueryCode(value: string): ParsedMailQueryCode {
  const input = value.trim();
  if (!input) throw new Error('请输入邮件查询码');
  if (input.length > V2_MAIL_VIEWER_LIMITS.credential) {
    throw new Error('邮件查询码过长');
  }

  const separatorIndex = input.indexOf(CREDENTIAL_SEPARATOR);
  const legacyEmail = separatorIndex > 0 ? input.slice(0, separatorIndex).trim() : '';
  const queryCode =
    legacyEmail && EMAIL_PATTERN.test(legacyEmail)
      ? input.slice(separatorIndex + CREDENTIAL_SEPARATOR.length).trim()
      : input;
  if (!queryCode) throw new Error('请输入邮件查询码');
  if (
    queryCode.length > V2_MAIL_VIEWER_LIMITS.queryCode ||
    Array.from(queryCode).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error('邮件查询码格式不正确');
  }
  return { queryCode };
}

export function parseMailQueryCodeLines(value: string) {
  if (value.length > V2_MAIL_VIEWER_LIMITS.batchLength) {
    return {
      items: [] as ParsedMailQueryCode[],
      errors: [{ lineNumber: 0, message: '批量内容过长' }] as MailQueryCodeLineError[]
    };
  }

  const items: ParsedMailQueryCode[] = [];
  const errors: MailQueryCodeLineError[] = [];
  const seen = new Set<string>();
  const lines = value.split(/\r?\n/);
  if (lines.length > V2_MAIL_VIEWER_LIMITS.batchLines) {
    return {
      items,
      errors: [
        { lineNumber: 0, message: `每次最多处理 ${V2_MAIL_VIEWER_LIMITS.batchLines} 个查询码` }
      ]
    };
  }

  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const item = parseMailQueryCode(line);
      if (seen.has(item.queryCode)) {
        errors.push({ lineNumber: index + 1, message: '邮件查询码重复' });
        return;
      }
      seen.add(item.queryCode);
      items.push(item);
    } catch (error) {
      errors.push({
        lineNumber: index + 1,
        message: error instanceof Error ? error.message : '格式不正确'
      });
    }
  });

  return { items, errors };
}

export function mailBodyToPlainText(value: string) {
  if (!value.trim()) return '';
  if (typeof DOMParser === 'undefined') return normalizePlainText(fallbackText(value));

  const document = new DOMParser().parseFromString(value, 'text/html');
  document.querySelectorAll(REMOVED_ELEMENTS).forEach((element) => element.remove());
  document.querySelectorAll('br, hr').forEach((element) => element.replaceWith('\n'));
  document.querySelectorAll(BLOCK_ELEMENTS).forEach((element) => element.append('\n'));
  return normalizePlainText(document.body.textContent ?? '');
}

function fallbackText(value: string) {
  return value
    .replace(
      /<(script|style|noscript|iframe|object|embed|svg|canvas|form|video|audio|picture)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      ''
    )
    .replace(/<(img|input|button|source|link|meta)\b[^>]*>/gi, '')
    .replace(
      /<br\s*\/?>|<hr\s*\/?>|<\/(p|div|section|article|header|footer|li|tr|table|h[1-6])\s*>/gi,
      '\n'
    )
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function normalizePlainText(value: string) {
  return value
    .replace(/\r/g, '')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n[\t ]+/g, '\n')
    .replace(/[\t ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
