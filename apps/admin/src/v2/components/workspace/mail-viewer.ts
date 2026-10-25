import {
  V2_MAIL_VIEWER_LIMITS,
  V2_VENDURE_VIRTUAL_MAIL_LIMIT,
  type V2MailViewerMessage
} from '@apple-business/shared';

const CREDENTIAL_SEPARATOR = '----';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REMOVED_ELEMENTS =
  'script, style, noscript, iframe, object, embed, svg, canvas, form, input, button, video, audio, source, picture, img, link, meta';
const BLOCK_ELEMENTS =
  'p, div, section, article, header, footer, li, tr, table, h1, h2, h3, h4, h5, h6';

export interface ParsedMailQueryCode {
  queryCode: string;
}

export type MailQueryKind = 'managed' | 'vendure-primary' | 'vendure-virtual';

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

export function classifyMailQueryCode(value: string): MailQueryKind {
  let queryCode = value.trim();
  try {
    queryCode = parseMailQueryCode(value).queryCode;
  } catch {
    // Keep incomplete input in the managed state until it becomes a valid Vendure code.
  }
  if (/^BUY-/i.test(queryCode)) return 'vendure-virtual';
  if (/^MSTR-/i.test(queryCode)) return 'vendure-primary';
  return 'managed';
}

export function resolveMailViewerLimit(queryCode: string, requestedLimit: number) {
  return classifyMailQueryCode(queryCode) === 'vendure-virtual'
    ? V2_VENDURE_VIRTUAL_MAIL_LIMIT
    : requestedLimit;
}

export function filterMailViewerMessages(items: V2MailViewerMessage[], virtualEmailId: string) {
  return virtualEmailId ? items.filter((item) => item.virtualEmailId === virtualEmailId) : items;
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

export interface MailBodyPart {
  text: string;
  href?: string;
}

export function safeMailLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) return undefined;
    if (url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function mailBodyParts(value: string): MailBodyPart[] {
  const parts: MailBodyPart[] = [];
  function appendText(text: string) {
    const pattern = /https?:\/\/[^\s<>"']+/gi;
    let start = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index!;
      if (index > start) parts.push({ text: text.slice(start, index) });
      const url = match[0].replace(/[.,;!?，。；！？）)]+$/, '');
      parts.push({ text: url, href: safeMailLink(url) });
      start = index + url.length;
    }
    if (start < text.length) parts.push({ text: text.slice(start) });
  }
  if (!/<[a-z][\s\S]*>/i.test(value)) {
    appendText(value);
    return parts;
  }
  if (typeof DOMParser === 'undefined') {
    appendText(mailBodyToPlainText(value));
    return parts;
  }
  const document = new DOMParser().parseFromString(value, 'text/html');
  document.querySelectorAll(REMOVED_ELEMENTS).forEach((element) => element.remove());
  function visit(node: Node) {
    if (node.nodeType === 3) {
      appendText(node.textContent || '');
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.tagName === 'A') {
      const href = safeMailLink(element.getAttribute('href') || '');
      parts.push({ text: element.textContent || href || '', ...(href ? { href } : {}) });
      return;
    }
    if (['BR', 'HR'].includes(element.tagName)) parts.push({ text: '\n' });
    element.childNodes.forEach(visit);
    if (element.matches(BLOCK_ELEMENTS)) parts.push({ text: '\n' });
  }
  document.body.childNodes.forEach(visit);
  return parts;
}
