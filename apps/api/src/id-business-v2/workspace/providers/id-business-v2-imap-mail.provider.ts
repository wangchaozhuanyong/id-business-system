import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { V2MailProvider, V2MailViewerMessage } from '@apple-business/shared';
import { ImapFlow, type FetchMessageObject, type MessageAddressObject } from 'imapflow';
import { simpleParser } from 'mailparser';

const IMAP_PORT = 993;
const CONNECTION_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 15_000;
const CONNECTION_RETRY_DELAY_MS = 300;
const MAX_PROVIDER_CONNECTIONS = 4;
const MAX_PROVIDER_WAITERS = 24;
const PROVIDER_QUEUE_TIMEOUT_MS = 12_000;
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
  constructor(
    public readonly code:
      | 'edge_runtime'
      | 'connection_failed'
      | 'provider_busy'
      | 'response_invalid'
  ) {
    super('邮箱服务暂时不可用');
    this.name = 'MailProviderUnavailableError';
  }
}

interface ProviderConnectionWaiter {
  reject: (error: MailProviderUnavailableError) => void;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ProviderConnectionState {
  active: number;
  waiters: ProviderConnectionWaiter[];
}

@Injectable()
export class IdBusinessV2ImapMailProvider {
  private readonly connectionStates = new Map<V2MailProvider, ProviderConnectionState>();

  constructor(private readonly configService: ConfigService) {}

  async verify(input: ImapMailboxInput) {
    return this.withProviderConnection(input.provider, () => this.verifyWithConnection(input));
  }

  async query(input: ImapMailboxInput, limit: number): Promise<V2MailViewerMessage[]> {
    return this.withProviderConnection(input.provider, () =>
      this.queryWithConnection(input, limit)
    );
  }

  private async verifyWithConnection(input: ImapMailboxInput) {
    const authUsers = this.getAuthUsers(input);
    for (const [index, authUser] of authUsers.entries()) {
      try {
        await this.verifyAuthUser(input, authUser);
        return;
      } catch (error) {
        if (error instanceof MailProviderAuthenticationError && index < authUsers.length - 1) {
          continue;
        }
        throw error;
      }
    }
  }

  private async verifyAuthUser(input: ImapMailboxInput, authUser: string) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = this.createClient(input, true, authUser);
      try {
        await client.connect();
        return;
      } catch (error) {
        const mappedError = this.mapProviderError(error);
        if (
          mappedError instanceof MailProviderUnavailableError &&
          mappedError.code === 'connection_failed' &&
          attempt === 0
        ) {
          await this.delay(CONNECTION_RETRY_DELAY_MS);
          continue;
        }
        throw mappedError;
      } finally {
        await this.disconnect(client);
      }
    }
  }

  private async queryWithConnection(
    input: ImapMailboxInput,
    limit: number
  ): Promise<V2MailViewerMessage[]> {
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
    return localPart && localPart !== input.email ? [localPart, input.email] : [input.email];
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
    const serverResponseCode = this.readErrorField(error, 'serverResponseCode');
    const providerResponse = [
      this.readErrorField(error, 'message'),
      this.readErrorField(error, 'response'),
      this.readErrorField(error, 'text'),
      this.readErrorField(error, 'statusText'),
      this.readNestedErrorField(error, 'cause', 'code'),
      this.readNestedErrorField(error, 'cause', 'message')
    ].join(' ');
    const authenticationFailed =
      this.readErrorField(error, 'authenticationFailed') === 'true' ||
      /auth|credentials|login|password/i.test(`${code} ${responseCode} ${serverResponseCode}`) ||
      /authentication failed|authorization failed|invalid credentials|login failed|app(?:lication)?-specific password/i.test(
        providerResponse
      );
    return authenticationFailed
      ? new MailProviderAuthenticationError()
      : new MailProviderUnavailableError('connection_failed');
  }

  private readErrorField(error: unknown, field: string) {
    if (!error || typeof error !== 'object' || !(field in error)) return '';
    return String((error as Record<string, unknown>)[field] ?? '');
  }

  private readNestedErrorField(error: unknown, parent: string, field: string) {
    if (!error || typeof error !== 'object' || !(parent in error)) return '';
    const nested = (error as Record<string, unknown>)[parent];
    return this.readErrorField(nested, field);
  }

  private async withProviderConnection<T>(provider: V2MailProvider, work: () => Promise<T>) {
    await this.acquireProviderConnection(provider);
    try {
      return await work();
    } finally {
      this.releaseProviderConnection(provider);
    }
  }

  private acquireProviderConnection(provider: V2MailProvider) {
    const state = this.getConnectionState(provider);
    if (state.active < MAX_PROVIDER_CONNECTIONS) {
      state.active += 1;
      return Promise.resolve();
    }
    if (state.waiters.length >= MAX_PROVIDER_WAITERS) {
      return Promise.reject(new MailProviderUnavailableError('provider_busy'));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: ProviderConnectionWaiter = {
        reject,
        resolve,
        timer: setTimeout(() => {
          const index = state.waiters.indexOf(waiter);
          if (index >= 0) state.waiters.splice(index, 1);
          reject(new MailProviderUnavailableError('provider_busy'));
        }, PROVIDER_QUEUE_TIMEOUT_MS)
      };
      state.waiters.push(waiter);
    });
  }

  private releaseProviderConnection(provider: V2MailProvider) {
    const state = this.getConnectionState(provider);
    state.active = Math.max(0, state.active - 1);
    const waiter = state.waiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    state.active += 1;
    waiter.resolve();
  }

  private getConnectionState(provider: V2MailProvider) {
    const existing = this.connectionStates.get(provider);
    if (existing) return existing;
    const state: ProviderConnectionState = { active: 0, waiters: [] };
    this.connectionStates.set(provider, state);
    return state;
  }

  private delay(milliseconds: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }

  private async disconnect(client: ImapFlow) {
    if (!client.usable) {
      client.close();
      return;
    }
    await client.logout().catch(() => client.close());
  }
}
