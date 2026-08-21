import { createHash, createHmac } from 'node:crypto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { FieldEncryptionService } from '../common/crypto/field-encryption.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { SecurityService } from './security.service';

describe('SecurityService', () => {
  const now = new Date('2026-06-18T00:00:00.000Z');
  const future = new Date('2099-06-25T00:00:00.000Z');
  const userId = '33333333-3333-4333-8333-333333333333';
  const mfaBase32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const authenticatedUser = {
    id: userId,
    username: 'admin',
    displayName: '管理员',
    roles: ['admin'],
    permissions: [],
    mustResetPassword: false
  };

  function generateTestTotp(secret: string) {
    const counter = Math.floor(Date.now() / 1000 / 30);
    const key = base32Decode(secret);
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    counterBuffer.writeUInt32BE(counter >>> 0, 4);
    const hmac = createHmac('sha1', key).update(counterBuffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);
    return String(binary % 1_000_000).padStart(6, '0');
  }

  function base32Decode(value: string) {
    const normalized = value.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
    let bits = 0;
    let buffer = 0;
    const bytes: number[] = [];
    for (const char of normalized) {
      const index = mfaBase32Alphabet.indexOf(char);
      if (index < 0) throw new Error('invalid base32');
      buffer = (buffer << 5) | index;
      bits += 5;
      if (bits >= 8) {
        bytes.push((buffer >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return Buffer.from(bytes);
  }

  function createService() {
    const securitySettingStore = new Map<string, Record<string, unknown>>();
    const loginLog = {
      id: '77777777-7777-4777-8777-777777777777',
      userId,
      username: 'admin',
      status: 'failed',
      failureReason: 'password_invalid',
      ip: '127.0.0.1',
      userAgent: 'unit-test',
      location: null,
      abnormal: false,
      createdAt: now
    };
    const activeSession = {
      id: 'session-id',
      userId,
      tokenHash: 'hash',
      ip: '127.0.0.1',
      userAgent: 'unit-test',
      lastActiveAt: now,
      expiresAt: future,
      revokedAt: null,
      createdAt: now,
      user: {
        id: userId,
        username: 'admin',
        displayName: '管理员'
      }
    };
    const ipWhitelist = {
      id: 'ip-whitelist-id',
      ipOrCidr: '127.0.0.1',
      scope: 'admin',
      enabled: true,
      remark: 'local',
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
      createdBy: {
        id: userId,
        username: 'admin',
        displayName: '管理员'
      }
    };
    const sensitiveAccessLog = {
      id: 'sensitive-log-id',
      userId,
      module: 'apple',
      fieldName: 'password',
      objectType: 'apple_account',
      objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      accessReason: 'unit test',
      approved: true,
      approvalId: null,
      ip: '127.0.0.1',
      userAgent: 'unit-test',
      createdAt: now,
      user: {
        id: userId,
        username: 'admin',
        displayName: '管理员'
      }
    };
    const sensitiveApproval = {
      id: 'sensitive-approval-id',
      requesterId: userId,
      approverId: null,
      module: 'apple',
      fieldName: 'password',
      objectType: 'apple_account',
      objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      reason: 'unit test',
      status: 'pending',
      decisionNote: null,
      approvedAt: null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
      requester: {
        id: userId,
        username: 'admin',
        displayName: '管理员'
      },
      approver: null
    };
    let transactionQueue = Promise.resolve<unknown>(undefined);
    const prisma = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ locked: 1 }]),
      $transaction: jest.fn((input: unknown) => {
        if (Array.isArray(input)) return Promise.all(input);
        if (typeof input === 'function') {
          const result = transactionQueue.then(() => input(prisma));
          transactionQueue = result.then(
            () => undefined,
            () => undefined
          );
          return result;
        }
        throw new Error('Unexpected transaction input');
      }),
      loginLog: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            ...loginLog,
            ...data,
            createdAt: now
          })
        ),
        findMany: jest.fn().mockResolvedValue([loginLog]),
        count: jest.fn().mockResolvedValue(1),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      activeSession: {
        create: jest.fn().mockResolvedValue(activeSession),
        findUnique: jest.fn().mockResolvedValue(activeSession),
        findMany: jest.fn().mockResolvedValue([activeSession]),
        count: jest.fn().mockResolvedValue(1),
        update: jest.fn().mockResolvedValue({
          ...activeSession,
          revokedAt: now
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      ipWhitelist: {
        findMany: jest.fn().mockResolvedValue([ipWhitelist]),
        findUnique: jest.fn().mockResolvedValue(ipWhitelist),
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockResolvedValue(ipWhitelist),
        update: jest.fn().mockResolvedValue(ipWhitelist),
        delete: jest.fn().mockResolvedValue(ipWhitelist)
      },
      sensitiveAccessLog: {
        findMany: jest.fn().mockResolvedValue([sensitiveAccessLog]),
        count: jest.fn().mockResolvedValue(1)
      },
      sensitiveAccessApproval: {
        findMany: jest.fn().mockResolvedValue([sensitiveApproval]),
        count: jest.fn().mockResolvedValue(1)
      },
      securitySetting: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          const value = securitySettingStore.get(where.key);
          return Promise.resolve(
            value
              ? {
                  id: `setting-${where.key}`,
                  key: where.key,
                  value,
                  remark: null,
                  updatedByUserId: userId,
                  createdAt: now,
                  updatedAt: now
                }
              : null
          );
        }),
        upsert: jest.fn().mockImplementation(({ where, create, update }) => {
          const value = (update?.value ?? create.value) as Record<string, unknown>;
          securitySettingStore.set(where.key, value);
          return Promise.resolve({
            id: `setting-${where.key}`,
            key: where.key,
            value,
            remark: update?.remark ?? create.remark,
            updatedByUserId: update?.updatedByUserId ?? create.updatedByUserId,
            createdAt: now,
            updatedAt: now
          });
        }),
        findMany: jest.fn().mockImplementation(({ where }) => {
          const keys = (where?.key?.in ?? []) as string[];
          return Promise.resolve(
            keys.flatMap((key) => {
              const value = securitySettingStore.get(key);
              return value ? [{ key, value }] : [];
            })
          );
        })
      },
      user: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: userId,
            username: 'admin',
            displayName: '管理员',
            status: 'active',
            userRoles: [{ role: { code: 'admin' } }]
          }
        ]),
        count: jest.fn().mockResolvedValue(1),
        findUnique: jest.fn().mockResolvedValue({
          status: 'active',
          userRoles: [{ role: { code: 'admin' } }]
        })
      }
    } as unknown as PrismaService;
    const auditLogsService = {
      create: jest.fn().mockResolvedValue({})
    } as unknown as AuditLogsService;
    const fieldEncryptionService = {
      encrypt: jest.fn((value: string | null | undefined) => (value ? `enc:${value}` : null)),
      decrypt: jest.fn((value: string | null | undefined) =>
        value?.startsWith('enc:') ? value.slice(4) : null
      ),
      hash: jest.fn((value: string | null | undefined) =>
        value ? createHash('sha256').update(value).digest('hex') : null
      )
    } as unknown as FieldEncryptionService;

    return {
      service: new SecurityService(prisma, auditLogsService, fieldEncryptionService),
      prisma,
      auditLogsService,
      activeSession
    };
  }

  it('records a single failed login without marking it abnormal', async () => {
    const { service, prisma } = createService();

    const result = await service.recordLoginAttempt({
      userId,
      username: 'admin',
      status: 'failed',
      failureReason: 'password_invalid',
      ip: '127.0.0.1',
      userAgent: 'unit-test'
    });

    expect(result.status).toBe('failed');
    expect(result.abnormal).toBe(false);
    expect(prisma.loginLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          username: 'admin',
          status: 'failed',
          failureReason: 'password_invalid',
          abnormal: false
        })
      })
    );
  });

  it('marks repeated failed login as abnormal', async () => {
    const { service, prisma } = createService();
    (prisma.loginLog.count as jest.Mock).mockResolvedValueOnce(4).mockResolvedValueOnce(2);

    const result = await service.recordLoginAttempt({
      userId,
      username: 'admin',
      status: 'failed',
      failureReason: 'password_invalid',
      ip: '127.0.0.1',
      userAgent: 'unit-test'
    });

    expect(result.status).toBe('failed');
    expect(result.abnormal).toBe(true);
    expect(prisma.loginLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          username: 'admin',
          status: 'failed',
          abnormal: true
        })
      })
    );
  });

  it('uses configured password policy failure threshold for abnormal login detection', async () => {
    const { service, prisma } = createService();
    await service.updatePasswordPolicy(
      {
        minLength: 8,
        requireUppercase: true,
        requireLowercase: true,
        requireNumber: true,
        requireSymbol: false,
        maxFailedAttempts: 3
      },
      authenticatedUser
    );
    (prisma.loginLog.count as jest.Mock).mockResolvedValueOnce(2).mockResolvedValueOnce(0);

    const result = await service.recordLoginAttempt({
      userId,
      username: 'admin',
      status: 'failed',
      failureReason: 'password_invalid',
      ip: '127.0.0.1',
      userAgent: 'unit-test'
    });

    expect(result.abnormal).toBe(true);
  });

  it('persists an explicitly abnormal login', async () => {
    const { service } = createService();

    const result = await service.recordLoginAttempt({
      userId,
      username: 'admin',
      status: 'success',
      abnormal: true,
      ip: '127.0.0.1',
      userAgent: 'unit-test'
    });

    expect(result.status).toBe('success');
    expect(result.abnormal).toBe(true);
  });

  it('reserves and finalizes a login attempt under MySQL transaction row locks', async () => {
    const { service, prisma } = createService();
    (prisma.loginLog.count as jest.Mock).mockResolvedValue(0);

    const reservation = await service.reserveLoginAttempt({
      username: 'admin',
      ip: '127.0.0.1',
      userAgent: 'unit-test'
    });

    expect(reservation).toEqual({
      allowed: true,
      reservationId: '77777777-7777-4777-8777-777777777777'
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    for (const [query] of (prisma.$executeRaw as jest.Mock).mock.calls) {
      expect(query.join('')).toContain('INSERT INTO "mysql_transaction_locks"');
    }
    expect(prisma.loginLog.create).toHaveBeenCalledWith({
      data: {
        username: 'admin',
        status: 'blocked',
        failureReason: 'authentication_in_progress',
        ip: '127.0.0.1',
        userAgent: 'unit-test',
        abnormal: false
      },
      select: { id: true }
    });

    await expect(
      service.finalizeLoginAttempt('77777777-7777-4777-8777-777777777777', {
        userId,
        status: 'success'
      })
    ).resolves.toBe(true);
    expect(prisma.loginLog.updateMany).toHaveBeenCalledWith({
      where: {
        id: '77777777-7777-4777-8777-777777777777',
        failureReason: 'authentication_in_progress'
      },
      data: {
        userId,
        status: 'success',
        failureReason: null,
        abnormal: false
      }
    });
  });

  it('serializes concurrent login reservations and enforces the configured threshold', async () => {
    const { service, prisma } = createService();
    (prisma.securitySetting.findUnique as jest.Mock).mockResolvedValue({
      value: { maxFailedAttempts: 1 }
    });
    (prisma.loginLog.count as jest.Mock).mockImplementation(() =>
      Promise.resolve((prisma.loginLog.create as jest.Mock).mock.calls.length)
    );

    const [first, second] = await Promise.all([
      service.reserveLoginAttempt({ username: 'admin', ip: '127.0.0.1' }),
      service.reserveLoginAttempt({ username: 'admin', ip: '127.0.0.1' })
    ]);

    expect(first).toEqual({
      allowed: true,
      reservationId: '77777777-7777-4777-8777-777777777777'
    });
    expect(second).toEqual({ allowed: false, retryAfterMs: 900_000 });
    expect(prisma.loginLog.create).toHaveBeenCalledTimes(1);
  });

  it('creates active session with token hash instead of plaintext token', async () => {
    const { service, prisma } = createService();

    await service.createActiveSession({
      userId,
      accessToken: 'plain.jwt.token',
      expiresAt: future,
      ip: '127.0.0.1',
      userAgent: 'unit-test'
    });

    const data = (prisma.activeSession.create as jest.Mock).mock.calls[0]?.[0]?.data;
    expect(data.tokenHash).toHaveLength(64);
    expect(data.tokenHash).not.toBe('plain.jwt.token');
  });

  it('reuses a registered provider session without replacing its original device metadata', async () => {
    const { service, prisma, activeSession } = createService();
    const sessionIdentifier = 'supabase:55555555-5555-4555-8555-555555555555';
    const tokenHash = createHash('sha256').update(sessionIdentifier).digest('hex');
    (prisma.activeSession.findUnique as jest.Mock)
      .mockResolvedValueOnce({
        ...activeSession,
        lastActiveAt: new Date(Date.now() - 120_000)
      })
      .mockResolvedValueOnce({
        ...activeSession,
        lastActiveAt: new Date()
      });

    await expect(
      service.ensureActiveSession({
        userId,
        sessionIdentifier,
        expiresAt: future,
        ip: '127.0.0.1',
        userAgent: 'original-device'
      })
    ).resolves.toBe(true);
    await expect(
      service.ensureActiveSession({
        userId,
        sessionIdentifier,
        expiresAt: future,
        ip: '203.0.113.25',
        userAgent: 'different-device'
      })
    ).resolves.toBe(true);

    expect(prisma.activeSession.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.activeSession.updateMany).toHaveBeenCalledTimes(1);
    for (const [input] of (prisma.activeSession.updateMany as jest.Mock).mock.calls) {
      expect(input.where).toEqual(
        expect.objectContaining({
          id: 'session-id',
          userId,
          tokenHash,
          revokedAt: null,
          expiresAt: { gt: expect.any(Date) },
          lastActiveAt: { lte: expect.any(Date) }
        })
      );
      expect(input.data).toEqual(
        expect.objectContaining({
          lastActiveAt: expect.any(Date)
        })
      );
      expect(input.data).not.toHaveProperty('expiresAt');
      expect(input.data).not.toHaveProperty('ip');
      expect(input.data).not.toHaveProperty('userAgent');
    }
    expect(prisma.activeSession.create).not.toHaveBeenCalled();
  });

  it('keeps a session active when another request wins the periodic touch race', async () => {
    const { service, prisma, activeSession } = createService();
    (prisma.activeSession.findUnique as jest.Mock)
      .mockResolvedValueOnce({
        ...activeSession,
        lastActiveAt: new Date(Date.now() - 120_000)
      })
      .mockResolvedValueOnce({
        userId,
        revokedAt: null,
        expiresAt: future
      });
    (prisma.activeSession.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });

    await expect(
      service.ensureActiveSession({
        userId,
        sessionIdentifier: 'supabase:touch-race',
        expiresAt: future
      })
    ).resolves.toBe(true);

    expect(prisma.activeSession.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.activeSession.updateMany).toHaveBeenCalledTimes(1);
  });

  it.each(['unregistered', 'revoked'])(
    'rejects an %s provider session instead of recreating it',
    async (status) => {
      const { service, prisma } = createService();
      (prisma.activeSession.findUnique as jest.Mock).mockResolvedValueOnce(
        status === 'revoked'
          ? {
              id: 'session-id',
              userId,
              revokedAt: now,
              expiresAt: future,
              lastActiveAt: now
            }
          : null
      );

      await expect(
        service.ensureActiveSession({
          userId,
          sessionIdentifier: 'supabase:66666666-6666-4666-8666-666666666666',
          expiresAt: future,
          ip: '127.0.0.1',
          userAgent: 'unit-test'
        })
      ).resolves.toBe(false);

      expect(prisma.activeSession.create).not.toHaveBeenCalled();
    }
  );

  it('rejects an expired provider token before touching the registered session', async () => {
    const { service, prisma } = createService();

    await expect(
      service.ensureActiveSession({
        userId,
        sessionIdentifier: 'supabase:66666666-6666-4666-8666-666666666667',
        expiresAt: new Date(Date.now() - 1_000),
        ip: '127.0.0.1',
        userAgent: 'unit-test'
      })
    ).resolves.toBe(false);

    expect(prisma.activeSession.updateMany).not.toHaveBeenCalled();
  });

  it('observes provider session revocation on the next request', async () => {
    const { service, prisma } = createService();
    const sessionIdentifier = 'supabase:77777777-7777-4777-8777-777777777777';
    const tokenHash = createHash('sha256').update(sessionIdentifier).digest('hex');
    const registeredSession = {
      id: '77777777-7777-4777-8777-777777777777',
      userId,
      tokenHash,
      ip: '127.0.0.1',
      userAgent: 'unit-test',
      lastActiveAt: now,
      expiresAt: future,
      revokedAt: null,
      createdAt: now,
      user: {
        id: userId,
        username: 'admin',
        displayName: '管理员'
      }
    };

    await expect(
      service.ensureActiveSession({
        userId,
        sessionIdentifier,
        expiresAt: future,
        ip: '127.0.0.1',
        userAgent: 'unit-test'
      })
    ).resolves.toBe(true);
    await expect(service.isAccessTokenActive(sessionIdentifier)).resolves.toBe(true);
    expect(prisma.activeSession.findUnique).toHaveBeenCalledTimes(2);

    (prisma.activeSession.findUnique as jest.Mock)
      .mockResolvedValueOnce(registeredSession)
      .mockResolvedValueOnce({
        id: registeredSession.id,
        revokedAt: now,
        expiresAt: future,
        lastActiveAt: now
      });

    await expect(
      service.revokeSessionIdentifier(sessionIdentifier, authenticatedUser)
    ).resolves.toBe(true);
    await expect(service.isAccessTokenActive(sessionIdentifier)).resolves.toBe(false);

    expect(prisma.activeSession.findUnique).toHaveBeenCalledTimes(4);
    expect(prisma.activeSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: registeredSession.id
        },
        data: {
          revokedAt: expect.any(Date)
        }
      })
    );
  });

  it('accepts only active non-revoked access tokens', async () => {
    const { service, prisma } = createService();

    await expect(service.isAccessTokenActive('plain.jwt.token')).resolves.toBe(true);
    expect(prisma.activeSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastActiveAt: expect.any(Date)
        })
      })
    );

    (prisma.activeSession.findUnique as jest.Mock).mockResolvedValueOnce({
      revokedAt: now,
      expiresAt: future
    });

    await expect(service.isAccessTokenActive('plain.jwt.token')).resolves.toBe(false);
  });

  it('enforces enabled IP whitelist records when present', async () => {
    const { service, prisma } = createService();
    (prisma.ipWhitelist.findMany as jest.Mock).mockResolvedValueOnce([
      {
        ipOrCidr: '10.0.0.0/24'
      }
    ]);

    await expect(service.isRequestIpAllowed('10.0.0.25', ['admin', 'api'])).resolves.toBe(true);

    (prisma.ipWhitelist.findMany as jest.Mock).mockResolvedValueOnce([
      {
        ipOrCidr: '10.0.0.0/24'
      }
    ]);

    await expect(service.isRequestIpAllowed('10.0.1.25', ['admin', 'api'])).resolves.toBe(false);
  });

  it('rejects unsupported IP whitelist scopes', async () => {
    const { service } = createService();

    await expect(
      service.createIpWhitelist(
        {
          ipOrCidr: '10.0.0.1',
          scope: 'unsupported'
        },
        authenticatedUser
      )
    ).rejects.toThrow('scope is invalid');
  });

  it('rejects malformed addresses and unsupported IPv6 CIDR whitelist entries', async () => {
    const { service } = createService();

    await expect(
      service.createIpWhitelist(
        {
          ipOrCidr: 'not-an-ip',
          scope: 'admin'
        },
        authenticatedUser
      )
    ).rejects.toThrow('请输入有效的 IPv4 或 IPv6 地址。');
    await expect(
      service.createIpWhitelist(
        {
          ipOrCidr: '2001:db8::/32',
          scope: 'admin'
        },
        authenticatedUser
      )
    ).rejects.toThrow('CIDR 当前仅支持 IPv4 网段；IPv6 请填写单个地址。');
  });

  it('applies whitelisted login log sorting', async () => {
    const { service, prisma } = createService();

    const result = await service.listLoginLogs({
      page: 1,
      pageSize: 20,
      status: 'failed',
      sortBy: 'username',
      sortOrder: 'asc'
    });

    expect(result.total).toBe(1);
    expect(result.items[0]?.username).toBe('admin');
    expect(prisma.loginLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'failed'
        }),
        orderBy: [{ username: 'asc' }, { createdAt: 'desc' }]
      })
    );
    expect(prisma.loginLog.count).toHaveBeenCalled();
  });

  it('applies whitelisted IP whitelist sorting', async () => {
    const { service, prisma } = createService();

    const result = await service.listIpWhitelists({
      page: 1,
      pageSize: 20,
      scope: 'admin',
      sortBy: 'ipOrCidr',
      sortOrder: 'asc'
    });

    expect(result.total).toBe(1);
    expect(result.items[0]?.ipOrCidr).toBe('127.0.0.1');
    expect(prisma.ipWhitelist.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scope: 'admin'
        }),
        orderBy: [{ ipOrCidr: 'asc' }, { createdAt: 'desc' }]
      })
    );
    expect(prisma.ipWhitelist.count).toHaveBeenCalled();
  });

  it('applies whitelisted active session sorting', async () => {
    const { service, prisma } = createService();

    const result = await service.listActiveSessions({
      page: 1,
      pageSize: 20,
      revoked: 'false',
      sortBy: 'expiresAt',
      sortOrder: 'asc'
    });

    expect(result.total).toBe(1);
    expect(result.items[0]?.id).toBe('session-id');
    expect(prisma.activeSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          revokedAt: null
        }),
        orderBy: [{ expiresAt: 'asc' }, { lastActiveAt: 'desc' }]
      })
    );
    expect(prisma.activeSession.count).toHaveBeenCalled();
  });

  it('limits self-service session lists to the authenticated user', async () => {
    const { service, prisma } = createService();

    await service.listUserActiveSessions(
      userId,
      { page: 1, pageSize: 20 },
      'current-session-token'
    );

    expect(prisma.activeSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId,
          revokedAt: undefined
        })
      })
    );
    expect(prisma.activeSession.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ userId })
    });
  });

  it('blocks self-service revocation of another user or the current session', async () => {
    const { service, prisma } = createService();
    const currentToken = 'current-session-token';

    (prisma.activeSession.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'session-id',
      userId: '44444444-4444-4444-8444-444444444444',
      tokenHash: 'other-token-hash',
      revokedAt: null,
      user: {
        id: '44444444-4444-4444-8444-444444444444',
        username: 'other',
        displayName: '其他用户'
      }
    });
    await expect(
      service.revokeOwnSession('55555555-5555-4555-8555-555555555555', authenticatedUser)
    ).rejects.toThrow('Active session not found');

    (prisma.activeSession.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'session-id',
      userId,
      tokenHash: createHash('sha256').update(currentToken).digest('hex'),
      revokedAt: null,
      user: {
        id: userId,
        username: 'admin',
        displayName: '管理员'
      }
    });
    await expect(
      service.revokeOwnSession(
        '55555555-5555-4555-8555-555555555555',
        authenticatedUser,
        currentToken
      )
    ).rejects.toThrow('当前会话请使用退出登录操作。');
    expect(prisma.activeSession.update).not.toHaveBeenCalled();
  });

  it('applies whitelisted sensitive access log sorting', async () => {
    const { service, prisma } = createService();

    const result = await service.listSensitiveAccessLogs({
      page: 1,
      pageSize: 20,
      approved: 'true',
      sortBy: 'module',
      sortOrder: 'asc'
    });

    expect(result.total).toBe(1);
    expect(result.items[0]?.module).toBe('apple');
    expect(prisma.sensitiveAccessLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          approved: true
        }),
        orderBy: [{ module: 'asc' }, { createdAt: 'desc' }]
      })
    );
    expect(prisma.sensitiveAccessLog.count).toHaveBeenCalled();
  });

  it('applies whitelisted sensitive approval sorting', async () => {
    const { service, prisma } = createService();

    const result = await service.listSensitiveApprovals({
      page: 1,
      pageSize: 20,
      status: 'pending',
      sortBy: 'updatedAt',
      sortOrder: 'desc'
    });

    expect(result.total).toBe(1);
    expect(result.items[0]?.status).toBe('pending');
    expect(prisma.sensitiveAccessApproval.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'pending'
        }),
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }]
      })
    );
    expect(prisma.sensitiveAccessApproval.count).toHaveBeenCalled();
  });

  it('sets up and enables MFA with encrypted secret and recovery codes', async () => {
    const { service, prisma, auditLogsService } = createService();

    const setup = await service.setupMyMfa(authenticatedUser);
    const result = await service.enableMyMfa(authenticatedUser, {
      code: generateTestTotp(setup.secret)
    });

    expect(setup.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setup.otpauthUrl).toContain('otpauth://totp/');
    expect(result.enabled).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.recoveryCodes).toHaveLength(10);
    expect(prisma.securitySetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          value: expect.objectContaining({
            secretEncrypted: expect.stringMatching(/^enc:/),
            recoveryCodeHashes: expect.any(Array)
          })
        })
      })
    );
    expect(auditLogsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'security.mfa.enable',
        objectId: userId
      })
    );
  });

  it('requires MFA for an administrator when the global admin policy is enabled', async () => {
    const { service } = createService();

    await service.updateMfaSettings(
      {
        enabled: true,
        requiredForAdmins: true,
        issuer: 'Unit Test'
      },
      authenticatedUser
    );

    await expect(service.getMfaLoginRequirementForUser(authenticatedUser)).resolves.toEqual({
      required: true,
      bound: false,
      reason: 'admin_required'
    });
  });

  it('blocks the required-admin MFA policy until every active admin is bound', async () => {
    const { service } = createService();

    await expect(
      service.updateMfaSettingsSafely(
        {
          enabled: true,
          requiredForAdmins: true,
          issuer: 'Unit Test'
        },
        authenticatedUser
      )
    ).rejects.toThrow('仍有 1 个启用管理员未绑定 MFA，不能开启强制策略。');

    const setup = await service.setupMyMfa(authenticatedUser);
    await service.enableMyMfa(authenticatedUser, {
      code: generateTestTotp(setup.secret)
    });

    await expect(
      service.updateMfaSettingsSafely(
        {
          enabled: true,
          requiredForAdmins: true,
          issuer: 'Unit Test'
        },
        authenticatedUser
      )
    ).resolves.toEqual(
      expect.objectContaining({
        value: expect.objectContaining({
          enabled: true,
          requiredForAdmins: true
        })
      })
    );
  });

  it('lists MFA users without exposing encrypted secrets or recovery hashes', async () => {
    const { service } = createService();
    const setup = await service.setupMyMfa(authenticatedUser);
    await service.enableMyMfa(authenticatedUser, {
      code: generateTestTotp(setup.secret)
    });

    const result = await service.listMfaUsers({ page: 1, pageSize: 20 });
    const serialized = JSON.stringify(result);

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        id: userId,
        roles: ['admin'],
        enabled: true,
        configured: true
      })
    );
    expect(serialized).not.toContain('secretEncrypted');
    expect(serialized).not.toContain('recoveryCodeHashes');
  });

  it('requires MFA for a user with bound MFA even when admin forcing is off', async () => {
    const { service } = createService();
    const setup = await service.setupMyMfa(authenticatedUser);

    await service.enableMyMfa(authenticatedUser, {
      code: generateTestTotp(setup.secret)
    });

    await expect(service.getMfaLoginRequirementForUser(authenticatedUser)).resolves.toEqual({
      required: true,
      bound: true,
      reason: 'bound_user'
    });
  });

  it('accepts a recovery code once and decreases recovery count', async () => {
    const { service } = createService();

    const setup = await service.setupMyMfa(authenticatedUser);
    const result = await service.enableMyMfa(authenticatedUser, {
      code: generateTestTotp(setup.secret)
    });
    const verification = await service.verifyUserMfaCode(userId, result.recoveryCodes[0]);
    const status = await service.getMyMfaStatus(authenticatedUser);

    await expect(service.verifyUserMfaCode(userId, result.recoveryCodes[0])).rejects.toThrow(
      '动态验证码或恢复码错误，请重新输入。'
    );
    expect(verification.method).toBe('recovery_code');
    expect(status.recoveryCodeCount).toBe(9);
  });

  it('serializes concurrent recovery-code consumption so the code succeeds only once', async () => {
    const { service } = createService();
    const setup = await service.setupMyMfa(authenticatedUser);
    const enabled = await service.enableMyMfa(authenticatedUser, {
      code: generateTestTotp(setup.secret)
    });

    const results = await Promise.allSettled([
      service.verifyUserMfaCode(userId, enabled.recoveryCodes[0]),
      service.verifyUserMfaCode(userId, enabled.recoveryCodes[0])
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('does not let an enabled user replace MFA through the setup endpoint', async () => {
    const { service } = createService();
    const setup = await service.setupMyMfa(authenticatedUser);
    await service.enableMyMfa(authenticatedUser, {
      code: generateTestTotp(setup.secret)
    });

    await expect(service.setupMyMfa(authenticatedUser)).rejects.toThrow(
      'MFA 已启用，如需重新绑定请先按安全流程停用。'
    );
    await expect(service.getMfaLoginRequirementForUser(authenticatedUser)).resolves.toEqual({
      required: true,
      bound: true,
      reason: 'bound_user'
    });
  });

  it('resets user MFA through admin action', async () => {
    const { service, auditLogsService } = createService();

    const setup = await service.setupMyMfa(authenticatedUser);
    await service.enableMyMfa(authenticatedUser, {
      code: generateTestTotp(setup.secret)
    });
    const result = await service.resetUserMfa(userId, authenticatedUser);

    expect(result.enabled).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.recoveryCodeCount).toBe(0);
    expect(auditLogsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'security.mfa.admin_reset',
        objectId: userId
      })
    );
  });

  it('prevents disabling or resetting an active admin while required MFA is enabled', async () => {
    const { service } = createService();
    const setup = await service.setupMyMfa(authenticatedUser);
    await service.enableMyMfa(authenticatedUser, {
      code: generateTestTotp(setup.secret)
    });
    await service.updateMfaSettingsSafely(
      {
        enabled: true,
        requiredForAdmins: true,
        issuer: 'Unit Test'
      },
      authenticatedUser
    );

    await expect(
      service.disableMyMfa(authenticatedUser, {
        code: generateTestTotp(setup.secret),
        reason: 'unit test'
      })
    ).rejects.toThrow('管理员强制 MFA 已启用，不能停用当前绑定。');
    await expect(service.resetUserMfaSafely(userId, authenticatedUser)).rejects.toThrow(
      '管理员强制 MFA 已启用，不能重置启用管理员的绑定。'
    );
  });

  it('blocks an IP whitelist mutation that would exclude the current request IP', async () => {
    const { service, prisma } = createService();

    await expect(
      service.createIpWhitelistSafely(
        {
          ipOrCidr: '192.168.1.0/24',
          scope: 'admin',
          enabled: true,
          remark: 'unit test'
        },
        authenticatedUser,
        '10.0.0.25'
      )
    ).rejects.toThrow('修改后当前请求 IP 将不在白名单内，已阻止本次操作。');
    expect(prisma.ipWhitelist.create).not.toHaveBeenCalled();
  });

  it('allows an IP whitelist mutation when the current request IP remains included', async () => {
    const { service, prisma } = createService();

    await service.createIpWhitelistSafely(
      {
        ipOrCidr: '10.0.0.0/24',
        scope: 'admin',
        enabled: true,
        remark: 'unit test'
      },
      authenticatedUser,
      '10.0.0.25'
    );

    expect(prisma.ipWhitelist.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ipOrCidr: '10.0.0.0/24',
          enabled: true
        })
      })
    );
  });
});
