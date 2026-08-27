import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { V2MailProvider, V2MailViewerMessage } from '@apple-business/shared';
import { ImapFlow, type FetchMessageObject, type MessageAddressObject } from 'imapflow';
import { simpleParser } from 'mailparser';

const IMAP_PORT = 993;
const CONNECTION_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_SOURCE_BYTES = 1_000_000;
const MAX_BODY_CHARACTERS = 120_000;

const PROVIDER_HOSTS: Record<V2MailProvider, string> = {
  gmail: 'imap.gmail.com',
  icloud: 'imap.mail.me.com'
};

export interface ImapMailboxInput {
  appPassword: string;
  email: string;
  provider: V2MailProvider;
}

export class MailProviderAuthenticationError extends Error {
  constructor() {
    super('邮箱授权验证失败');
    this.name = 'MailProviderAuthenticationError';
  }
}

export class MailProviderUnavailableError extends Error {
  constructor(public readonly code: 'edge_runtime' | 'connection_failed' | 'response_invalid') {
    super('邮箱服务暂时不可用');
    this.name = 'MailProviderUnavailableError';
  }
}

@Injectable()
export class IdBusinessV2ImapMailProvider {
  constructor(private readonly configService: ConfigService) {}

  async verify(input: ImapMailboxInput) {
    const authUsers = this.getAuthUsers(input);
    for (const [index, authUser] of authUsers.entries()) {
      const client = this.createClient(input, true, authUser);
      try {
        await client.connect();
        return;
      } catch (error) {
        const mappedError = this.mapProviderError(error);
        if (
          mappedError instanceof MailProviderAuthenticationError &&
          index < authUsers.length - 1
        ) {
          continue;
        }
        throw mappedError;
      } finally {
        await this.disconnect(client);
      }
    }
  }

  async query(input: ImapMailboxInput, limit: number): Promise<V2MailViewerMessage[]> {
    const authUsers = this.getAuthUsers(input);
    for (const [index, authUser] of authUsers.entries()) {
      try {
        return await this.queryWithAuthUser(input, limit, authUser);
      } catch (error) {
        if (error instanceof MailProviderAuthenticationError && index < authUsers.length - 1) {
          continue;
        }
        throw error;
      }
    }
    throw new MailProviderAuthenticationError();
  }

  private async queryWithAuthUser(
    input: ImapMailboxInput,
    limit: number,
    authUser: string
  ): Promise<V2MailViewerMessage[]> {
    const client = this.createClient(input, false, authUser);
    let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>> | undefined;

    try {
      await client.connect();
      lock = await client.getMailboxLock('INBOX', {
        acquireTimeout: CONNECTION_TIMEOUT_MS,
        readOnly: true
      });
      const total = client.mailbox ? client.mailbox.exists : 0;
      if (total < 1) return [];

      const start = Math.max(1, total - limit + 1);
      const messages: V2MailViewerMessage[] = [];
      for await (const message of client.fetch(`${start}:${total}`, {
        envelope: true,
        internalDate: true,
        size: true,
        source: { maxLength: MAX_MESSAGE_SOURCE_BYTES }
      })) {
        messages.push(await this.toMessage(message, input.email));
      }
      return messages.reverse();
    } catch (error) {
      if (error instanceof MailProviderUnavailableError) throw error;
      throw this.mapProviderError(error);
    } finally {
      lock?.release();
      await this.disconnect(client);
    }
  }

  private createClient(input: ImapMailboxInput, verifyOnly: boolean, authUser: string) {
    return new ImapFlow({
      host: PROVIDER_HOSTS[input.provider],
      port: IMAP_PORT,
      secure: true,
      auth: {
        user: authUser,
        pass: input.appPassword
      },
      clientInfo: {
        name: 'ID Business Mail Viewer',
        version: '1.0'
      },
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: CONNECTION_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      maxLineLength: 256_000,
      maxLiteralSize: MAX_MESSAGE_SOURCE_BYTES + 64_000,
      maxResponseSize: MAX_MESSAGE_SOURCE_BYTES + 128_000,
      disableAutoIdle: true,
      logger: false,
      verifyOnly
    });
  }

  private getAuthUsers(input: ImapMailboxInput) {
    if (input.provider !== 'icloud') return [input.email];
    const localPart = input.email.split('@', 1)[0]?.trim();
    return localPart && localPart !== input.email ? [input.email, localPart] : [input.email];
  }

  private async toMessage(message: FetchMessageObject, fallbackTo: string) {
    const envelope = message.envelope;
    if (!message.source || (message.size ?? 0) > MAX_MESSAGE_SOURCE_BYTES) {
      return {
        body: '邮件内容超过安全读取上限，请登录原邮箱查看。',
        from: this.formatAddresses(envelope?.from),
        savedAt: this.toIsoDate(message.internalDate ?? envelope?.date),
        subject: envelope?.subject ?? '',
        to: this.formatAddresses(envelope?.to) || fallbackTo
      };
    }

    try {
      const parsed = await simpleParser(message.source, {
        keepCidLinks: true,
        maxHtmlLengthToParse: MAX_MESSAGE_SOURCE_BYTES,
        skipHtmlToText: false,
        skipImageLinks: true,
        skipTextToHtml: true
      });
      return {
        body: this.truncate(parsed.text?.trim() || this.htmlToText(parsed.html || '')),
        from: parsed.from?.text || this.formatAddresses(envelope?.from),
        savedAt: this.toIsoDate(parsed.date ?? message.internalDate ?? envelope?.date),
        subject: parsed.subject ?? envelope?.subject ?? '',
        to:
          this.formatParsedAddresses(parsed.to) || this.formatAddresses(envelope?.to) || fallbackTo
      };
    } catch {
      return {
        body: '邮件正文解析失败，请登录原邮箱查看。',
        from: this.formatAddresses(envelope?.from),
        savedAt: this.toIsoDate(message.internalDate ?? envelope?.date),
        subject: envelope?.subject ?? '',
        to: this.formatAddresses(envelope?.to) || fallbackTo
      };
    }
  }

  private formatParsedAddresses(value: { text: string } | Array<{ text: string }> | undefined) {
    return Array.isArray(value) ? value.map((item) => item.text).join(', ') : (value?.text ?? '');
  }

  private formatAddresses(addresses: MessageAddressObject[] | undefined) {
    return (addresses ?? [])
      .map((item) => (item.name ? `${item.name} <${item.address ?? ''}>` : (item.address ?? '')))
      .filter(Boolean)
      .join(', ');
  }

  private htmlToText(value: string) {
    return value
      .replace(
        /<(script|style|noscript|iframe|object|embed|svg|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
        ''
      )
      .replace(/<br\s*\/?>|<\/(p|div|section|article|li|tr|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private truncate(value: string) {
    return value.length > MAX_BODY_CHARACTERS
      ? `${value.slice(0, MAX_BODY_CHARACTERS)}\n\n（正文已截断）`
      : value;
  }

  private toIsoDate(value: Date | string | undefined) {
    const date = value instanceof Date ? value : new Date(value ?? Date.now());
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }

  private mapProviderError(error: unknown) {
    const code = this.readErrorField(error, 'code');
    const responseCode = this.readErrorField(error, 'responseCode');
    const authenticationFailed =
      /auth|credentials|login|password/i.test(`${code} ${responseCode}`) ||
      /authentication failed|invalid credentials|login failed|app-specific password/i.test(
        this.readErrorField(error, 'message')
      );
    return authenticationFailed
      ? new MailProviderAuthenticationError()
      : new MailProviderUnavailableError('connection_failed');
  }

  private readErrorField(error: unknown, field: string) {
    if (!error || typeof error !== 'object' || !(field in error)) return '';
    return String((error as Record<string, unknown>)[field] ?? '');
  }

  private async disconnect(client: ImapFlow) {
    if (!client.usable) {
      client.close();
      return;
    }
    await client.logout().catch(() => client.close());
  }
}
