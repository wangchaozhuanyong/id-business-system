import { describe, expect, it, vi } from 'vitest';
import { V2EmployeeAccountActionsService } from './v2-employee-account-actions.service';
import { verifyPassword } from '../../auth/password-hasher';
import { SYSTEM_SUPER_ADMIN_KEY } from '../system-super-admin';

const ownerId = '11111111-1111-4111-8111-111111111111';
const employeeId = '22222222-2222-4222-8222-222222222222';
const version = '2026-10-02T01:00:00.000Z';
const operator = {
  id: ownerId,
  username: 'ppfzj1314',
  displayName: '负责人',
  roles: ['admin', 'super_admin'],
  permissions: []
};

function fixture() {
  let state = {
    employee: {
      id: employeeId,
      username: 'employee',
      displayName: '员工',
      status: 'active',
      deletedAt: null as Date | null,
      updatedAt: new Date(version),
      passwordHash: ''
    },
    identity: { enabled: true, mustResetPassword: false },
    jobs: [
      {
        ownerId: employeeId,
        id: 'job',
        state: 'finished',
        accountKey: 'a'.repeat(64),
        result: {} as Record<string, unknown>
      }
    ],
    records: [
      {
        ownerId: employeeId,
        accountKey: 'a'.repeat(64),
        document: { payment_status: 'paid', amount: '12.3456', payment_attempted: true } as Record<
          string,
          unknown
        >
      }
    ],
    settings: new Map<string, unknown>([[SYSTEM_SUPER_ADMIN_KEY, { userId: ownerId }]]),
    audits: [] as unknown[],
    revoked: 0
  };
  let failAudit = false;
  let transferCalls = 0;
  function client(draft: typeof state) {
    const owner = {
      id: ownerId,
      username: 'ppfzj1314',
      displayName: '负责人',
      status: 'active',
      deletedAt: null
    };
    const findUnique = vi.fn(
      async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
        const result =
          where.id === ownerId ? owner : where.id === employeeId ? draft.employee : null;
        return result && select
          ? Object.fromEntries(
              Object.keys(select).map((key) => [key, result[key as keyof typeof result]])
            )
          : result;
      }
    );
    return {
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn(),
      user: {
        findUnique,
        updateMany: vi.fn(async ({ where, data }) => {
          if (
            draft.employee.deletedAt ||
            draft.employee.updatedAt.getTime() !== where.updatedAt.getTime()
          )
            return { count: 0 };
          Object.assign(draft.employee, data);
          return { count: 1 };
        }),
        update: vi.fn(async ({ data }) => Object.assign(draft.employee, data))
      },
      securitySetting: {
        findUnique: vi.fn(async ({ where }) =>
          draft.settings.has(where.key) ? { value: draft.settings.get(where.key) } : null
        ),
        create: vi.fn(async ({ data }) => {
          if (draft.settings.has(data.key)) throw new Error('duplicate registry key');
          draft.settings.set(data.key, data.value);
        })
      },
      v2AuthIdentity: {
        updateMany: vi.fn(async ({ data }) => {
          Object.assign(draft.identity, data);
          return { count: 1 };
        })
      },
      activeSession: {
        updateMany: vi.fn(async () => {
          draft.revoked += 2;
          return { count: 2 };
        })
      },
      idBusinessV2RegistrationJob: {
        count: vi.fn().mockResolvedValue(0),
        updateMany: vi.fn().mockResolvedValue({ count: 0 })
      },
      idBusinessV2RechargeJob: {
        findMany: vi.fn(async () => draft.jobs),
        updateMany: vi.fn(async ({ data }) => {
          transferCalls++;
          draft.jobs.forEach((job) => Object.assign(job, data));
        })
      },
      idBusinessV2RechargeRecord: {
        findMany: vi.fn(async () => draft.records),
        updateMany: vi.fn(async ({ data }) => {
          draft.records.forEach((record) => Object.assign(record, data));
        })
      },
      idBusinessV2RechargeAddress: { count: vi.fn(async () => 2) },
      idBusinessV2RechargeAddressUse: { updateMany: vi.fn() },
      idBusinessV2Customer: { count: vi.fn(async () => 1) },
      idBusinessV2Order: { count: vi.fn(async () => 2) },
      idBusinessV2Account: { count: vi.fn(async () => 3) },
      idBusinessV2GiftCard: { count: vi.fn(async () => 4) },
      idBusinessV2TotpAccount: { count: vi.fn(async () => 1) },
      idBusinessV2RelayJob: { count: vi.fn(async () => 0) },
      auditLog: {
        create: vi.fn(async ({ data }) => {
          if (failAudit) throw new Error('audit unavailable');
          draft.audits.push(data);
          return { id: 'audit' };
        })
      }
    };
  }
  const prisma = {
    get securitySetting() {
      return client(state).securitySetting;
    },
    get user() {
      return client(state).user;
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const draft = structuredClone(state);
      const result = await callback(client(draft));
      state = draft;
      return result;
    })
  };
  const audit = { create: vi.fn((data, tx) => tx.auditLog.create({ data })) };
  const security = {
    assertPasswordMeetsPolicy: vi.fn(async () => undefined),
    invalidateActiveSessionCache: vi.fn()
  };
  const identity = { invalidateAuthenticatedUser: vi.fn() };
  const events = { publishCommittedChangeBestEffort: vi.fn() };
  return {
    service: new V2EmployeeAccountActionsService(
      prisma as never,
      audit as never,
      security as never,
      identity as never,
      events as never
    ),
    get state() {
      return state;
    },
    get transferCalls() {
      return transferCalls;
    },
    security,
    events,
    failAudit: () => {
      failAudit = true;
    }
  };
}

describe('employee password reset and business takeover', () => {
  it('checks finished unknown-payment tasks and accepts only evidence for the same original order', async () => {
    const f = fixture();
    f.state.jobs[0]!.result = {
      payment_attempted: true,
      payment_status: 'unknown',
      checkout_identifier: 'original_checkout'
    };
    expect((await f.service.deletePreview(employeeId, operator)).canDelete).toBe(false);
    f.state.records[0]!.document.checkout_identifier = 'another_checkout';
    expect((await f.service.deletePreview(employeeId, operator)).canDelete).toBe(false);
    f.state.records[0]!.document.checkout_identifier = 'original_checkout';
    expect((await f.service.deletePreview(employeeId, operator)).canDelete).toBe(true);
    f.state.records[0]!.document.payment_status = 'unknown';
    expect((await f.service.deletePreview(employeeId, operator)).canDelete).toBe(false);
    f.state.records[0]!.document.operator_resolution = 'confirmed_no_bank_request';
    expect((await f.service.deletePreview(employeeId, operator)).canDelete).toBe(true);
  });
  it('revokes sessions, forces password reset, hashes the password and excludes it from audit', async () => {
    const f = fixture();
    await f.service.resetPassword(
      employeeId,
      { expectedUpdatedAt: version, newPassword: 'local-test-Password-72!' },
      operator
    );
    expect(await verifyPassword('local-test-Password-72!', f.state.employee.passwordHash)).toBe(
      true
    );
    expect(f.state.identity.mustResetPassword).toBe(true);
    expect(f.state.revoked).toBe(2);
    expect(JSON.stringify(f.state.audits)).not.toContain('Password-72');
  });

  it('protects the super administrator and refuses ordinary administrators', async () => {
    const f = fixture();
    await expect(f.service.deletePreview(ownerId, operator)).rejects.toThrow('受保护');
    await expect(
      f.service.resetPassword(
        employeeId,
        { expectedUpdatedAt: version, newPassword: 'local-test-Password-72!' },
        { ...operator, id: employeeId, roles: ['admin'] }
      )
    ).rejects.toThrow('仅系统超级管理员');
    expect(f.state.revoked).toBe(0);
  });

  it('blocks deletion of active jobs and unresolved payments', async () => {
    const f = fixture();
    f.state.jobs[0]!.state = 'confirming';
    f.state.records[0]!.document.payment_status = 'unknown';
    const preview = await f.service.deletePreview(employeeId, operator);
    expect(preview.canDelete).toBe(false);
    expect(preview.blockers).toHaveLength(2);
    await expect(f.service.remove(employeeId, preview, operator)).rejects.toThrow('未结束');
    expect(f.state.employee.deletedAt).toBeNull();
  });

  it('soft-deletes, takes over business, preserves money documents and is idempotent', async () => {
    const f = fixture();
    const document = structuredClone(f.state.records[0]!.document);
    const preview = await f.service.deletePreview(employeeId, operator);
    expect(await f.service.remove(employeeId, preview, operator)).toEqual({
      deleted: true,
      alreadyDeleted: false
    });
    expect(f.state.employee.status).toBe('disabled');
    expect(f.state.identity.enabled).toBe(false);
    expect(f.state.records[0]!.ownerId).toBe(ownerId);
    expect(f.state.records[0]!.document).toEqual(document);
    expect(f.state.settings.size).toBe(2);
    expect(await f.service.remove(employeeId, preview, operator)).toEqual({
      deleted: true,
      alreadyDeleted: true
    });
    expect(f.transferCalls).toBe(1);
    expect(f.state.audits).toHaveLength(1);
  });

  it('rejects changed impacts and keeps the account and business untouched', async () => {
    const f = fixture();
    const preview = await f.service.deletePreview(employeeId, operator);
    f.state.jobs.push({
      id: 'new-job',
      state: 'finished',
      ownerId: employeeId,
      accountKey: 'b'.repeat(64),
      result: {}
    });
    await expect(f.service.remove(employeeId, preview, operator)).rejects.toThrow('影响已变化');
    expect(f.state.employee.deletedAt).toBeNull();
    expect(f.transferCalls).toBe(0);
  });

  it('rolls back account, ownership and registry on audit failure', async () => {
    const f = fixture();
    const preview = await f.service.deletePreview(employeeId, operator);
    f.failAudit();
    await expect(f.service.remove(employeeId, preview, operator)).rejects.toThrow(
      'audit unavailable'
    );
    expect(f.state.employee.status).toBe('active');
    expect(f.state.records[0]!.ownerId).toBe(employeeId);
    expect(f.state.settings.size).toBe(1);
    expect(f.events.publishCommittedChangeBestEffort).not.toHaveBeenCalled();
  });

  it('refuses a stale reset version without changing the password or sessions', async () => {
    const f = fixture();
    await expect(
      f.service.resetPassword(
        employeeId,
        { expectedUpdatedAt: '2026-10-01T00:00:00.000Z', newPassword: 'local-test-Password-72!' },
        operator
      )
    ).rejects.toThrow('资料已变化');
    expect(f.state.employee.passwordHash).toBe('');
    expect(f.state.revoked).toBe(0);
  });
});
