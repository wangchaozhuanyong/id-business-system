import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const imapFlowState = vi.hoisted(() => ({
  authUsers: [] as string[]
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { exists: 0 };
    usable = true;

    constructor(private readonly options: { auth: { user: string } }) {
      imapFlowState.authUsers.push(options.auth.user);
    }

    async connect() {
      if (!this.options.auth.user.includes('@')) return;
      const error = new Error('Authentication failed');
      Object.assign(error, { responseCode: 'AUTHENTICATIONFAILED' });
      throw error;
    }

    async getMailboxLock() {
      return { release: vi.fn() };
    }

    async *fetch() {}

    async logout() {
      this.usable = false;
    }

    close() {
      this.usable = false;
    }
  }
}));

import {
  IdBusinessV2ImapMailProvider,
  MailProviderAuthenticationError
} from './id-business-v2-imap-mail.provider';

describe('IdBusinessV2ImapMailProvider', () => {
  const provider = new IdBusinessV2ImapMailProvider({
    get: vi.fn().mockReturnValue(undefined)
  } as unknown as ConfigService);

  beforeEach(() => {
    imapFlowState.authUsers.length = 0;
  });

  it('retries an iCloud login with the mailbox local part', async () => {
    await expect(
      provider.verify({
        appPassword: 'app-password',
        email: 'buyer@icloud.com',
        provider: 'icloud'
      })
    ).resolves.toBeUndefined();
    expect(imapFlowState.authUsers).toEqual(['buyer@icloud.com', 'buyer']);
  });

  it('uses the same iCloud fallback when reading messages', async () => {
    await expect(
      provider.query(
        {
          appPassword: 'app-password',
          email: 'buyer@icloud.com',
          provider: 'icloud'
        },
        10
      )
    ).resolves.toEqual([]);
    expect(imapFlowState.authUsers).toEqual(['buyer@icloud.com', 'buyer']);
  });

  it('does not retry Gmail with a local-part-only username', async () => {
    await expect(
      provider.verify({
        appPassword: 'app-password',
        email: 'buyer@gmail.com',
        provider: 'gmail'
      })
    ).rejects.toBeInstanceOf(MailProviderAuthenticationError);
    expect(imapFlowState.authUsers).toEqual(['buyer@gmail.com']);
  });
});
