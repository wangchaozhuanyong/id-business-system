import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2ManagedMailboxRepository } from './id-business-v2-managed-mailbox.repository';
import { IdBusinessV2GoogleSheetsSyncRepository } from './id-business-v2-google-sheets-sync.repository';

describe('workspace conditional persistence', () => {
  it('only updates the still-active mailbox with the same credential and unexpired query code', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const repository = new IdBusinessV2ManagedMailboxRepository({
      idBusinessV2ManagedMailbox: { updateMany }
    } as never);
    const snapshot = {
      providerCredentialEncrypted: 'encrypted-fixture',
      queryCodeHash: 'fixture-hash',
      queryCodeExpiresAt: new Date(Date.now() + 60000)
    };
    expect(
      await repository.updateQueryStateIfCurrent('fixture-id', snapshot, { status: 'active' })
    ).toBe(false);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'fixture-id',
        status: 'active',
        providerCredentialEncrypted: snapshot.providerCredentialEncrypted,
        queryCodeHash: snapshot.queryCodeHash,
        queryCodeExpiresAt: { equals: snapshot.queryCodeExpiresAt, gt: expect.any(Date) }
      },
      data: { status: 'active' }
    });
  });

  it('keeps Google updates atomic and restricted to the singleton and current lease', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const count = vi.fn().mockResolvedValue(0);
    const repository = new IdBusinessV2GoogleSheetsSyncRepository({
      idBusinessV2GoogleSheetsSync: { updateMany, count }
    } as never);
    const where = { enabled: true, runLeaseId: 'fixture-lease' };
    expect(await repository.updateConfigurationIfCurrent(where, { lastErrorCode: null })).toBe(
      false
    );
    expect(await repository.hasCurrentLease({ leaseId: 'fixture-lease' })).toBe(false);
    expect(updateMany).toHaveBeenCalledWith({
      where: { ...where, id: 1 },
      data: { lastErrorCode: null }
    });
    expect(count).toHaveBeenCalledWith({
      where: {
        ...where,
        id: 1,
        runLeaseExpiresAt: { gt: expect.any(Date) },
        googleOAuthClientId: undefined,
        clientSecretEncrypted: undefined,
        refreshTokenEncrypted: undefined
      }
    });
    expect(
      await repository.updateRunIfCurrent(
        {
          leaseId: 'fixture-lease',
          clientId: 'fixture-client',
          refreshTokenEncrypted: 'fixture-encrypted-refresh',
          clientSecretEncrypted: 'fixture-encrypted-secret'
        },
        { lastErrorCode: null }
      )
    ).toBe(false);
    expect(updateMany).toHaveBeenLastCalledWith({
      where: {
        ...where,
        id: 1,
        runLeaseExpiresAt: { gt: expect.any(Date) },
        googleOAuthClientId: 'fixture-client',
        refreshTokenEncrypted: 'fixture-encrypted-refresh',
        clientSecretEncrypted: 'fixture-encrypted-secret'
      },
      data: { lastErrorCode: null }
    });
  });
});
