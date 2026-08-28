import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const imapFlowState = vi.hoisted(() => ({
  authUsers: [] as string[],
  connect: undefined as undefined | ((user: string) => Promise<void>)
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { exists: 0 };
    usable = true;

    constructor(private readonly options: { auth: { user: string } }) {
      imapFlowState.authUsers.push(options.auth.user);
    }

    async connect() {
      await imapFlowState.connect?.(this.options.auth.user);
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
  let provider: IdBusinessV2ImapMailProvider;

  beforeEach(() => {
    imapFlowState.authUsers.length = 0;
    imapFlowState.connect = async (user) => {
      if (!user.includes('@')) return;
      const error = new Error('Authentication failed');
      Object.assign(error, {
        authenticationFailed: true,
        message: 'Command failed',
        serverResponseCode: 'AUTHENTICATIONFAILED'
      });
      throw error;
    };
    provider = new IdBusinessV2ImapMailProvider({
      get: vi.fn().mockReturnValue(undefined)
    } as unknown as ConfigService);
  });

  it('uses the mailbox local part first for an iCloud login', async () => {
    await expect(
      provider.verify({
        appPassword: 'app-password',
        email: 'buyer@icloud.com',
        provider: 'icloud'
      })
    ).resolves.toBeUndefined();
    expect(imapFlowState.authUsers).toEqual(['buyer']);
  });

  it('uses the same iCloud username order when reading messages', async () => {
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
    expect(imapFlowState.authUsers).toEqual(['buyer']);
  });

  it('falls back to the full iCloud address after a local-part authentication failure', async () => {
    imapFlowState.connect = async (user) => {
      if (user.includes('@')) return;
      throw Object.assign(new Error('Command failed'), {
        response: '1 NO [AUTHENTICATIONFAILED] Authentication Failed'
      });
    };
    await expect(
      provider.verify({
        appPassword: 'app-password',
        email: 'buyer@icloud.com',
        provider: 'icloud'
      })
    ).resolves.toBeUndefined();
    expect(imapFlowState.authUsers).toEqual(['buyer', 'buyer@icloud.com']);
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

  it('retries one transient connection failure before accepting the mailbox', async () => {
    let attempts = 0;
    imapFlowState.connect = async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
    };
    await expect(
      provider.verify({
        appPassword: 'app-password',
        email: 'buyer@gmail.com',
        provider: 'gmail'
      })
    ).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('limits simultaneous connections to one provider', async () => {
    let active = 0;
    let maximumActive = 0;
    let releaseConnections: () => void = () => undefined;
    const blocker = new Promise<void>((resolve) => {
      releaseConnections = resolve;
    });
    imapFlowState.connect = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await blocker;
      active -= 1;
    };
    const verifications = Array.from({ length: 8 }, (_, index) =>
      provider.verify({
        appPassword: 'app-password',
        email: `buyer${index}@gmail.com`,
        provider: 'gmail'
      })
    );
    await vi.waitFor(() => expect(imapFlowState.authUsers).toHaveLength(4));
    releaseConnections();
    await expect(Promise.all(verifications)).resolves.toHaveLength(8);
    expect(maximumActive).toBe(4);
  });
});
