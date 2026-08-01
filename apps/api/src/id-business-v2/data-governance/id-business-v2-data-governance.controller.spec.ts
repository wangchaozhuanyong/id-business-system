import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2DataGovernanceController } from './id-business-v2-data-governance.controller';

function createController() {
  const overview = vi.fn().mockResolvedValue({ safety: { restoreEnabled: true } });
  const recycleBin = vi.fn().mockResolvedValue({ items: [] });
  const jobs = vi.fn().mockResolvedValue({ items: [] });
  const job = vi.fn().mockResolvedValue({ id: 'job-id' });
  const createRestoreJob = vi.fn().mockResolvedValue({ id: 'restore-job' });
  const createCleanupJob = vi.fn().mockResolvedValue({ id: 'cleanup-job' });
  const decide = vi.fn().mockResolvedValue({ status: 'approved' });
  const execute = vi.fn().mockResolvedValue({ status: 'succeeded' });
  return {
    controller: new IdBusinessV2DataGovernanceController(
      { overview } as never,
      { recycleBin, jobs, job } as never,
      { createRestoreJob, createCleanupJob } as never,
      { decide } as never,
      { execute } as never
    ),
    mocks: {
      overview,
      recycleBin,
      jobs,
      job,
      createRestoreJob,
      createCleanupJob,
      decide,
      execute
    }
  };
}

describe('IdBusinessV2DataGovernanceController', () => {
  it('exposes overview, recycle-bin and job queries', async () => {
    const { controller, mocks } = createController();

    await controller.overview();
    await controller.recycleBin('2', '25', 'account');
    await controller.jobs('1', '20', 'recycle_restore', 'approved');
    await controller.job('job-id');

    expect(mocks.overview).toHaveBeenCalledWith();
    expect(mocks.recycleBin).toHaveBeenCalledWith({
      page: '2',
      pageSize: '25',
      entity: 'account'
    });
    expect(mocks.jobs).toHaveBeenCalledWith({
      page: '1',
      pageSize: '20',
      type: 'recycle_restore',
      status: 'approved'
    });
    expect(mocks.job).toHaveBeenCalledWith('job-id');
  });

  it('passes the authenticated administrator to preview, approval and execution services', async () => {
    const { controller, mocks } = createController();
    const operator = {
      id: 'operator-id',
      username: 'admin',
      displayName: '管理员',
      roles: ['admin'],
      permissions: []
    };
    const restoreDto = {
      items: [{ entity: 'account', id: 'account-id' }],
      reason: 'restore reason',
      backupEvidence: 'backup evidence',
      idempotencyKey: 'restore:001'
    };
    const cleanupDto = {
      olderThanDays: 30,
      reason: 'cleanup reason',
      backupEvidence: 'backup evidence',
      idempotencyKey: 'cleanup:001'
    };

    const request = { requestId: 'request-governance-001' };
    await controller.previewRestore(restoreDto, operator, request);
    await controller.previewCleanup(cleanupDto, operator, request);
    await controller.decide(
      'job-id',
      { decision: 'approved', reason: '同意执行' },
      operator,
      request
    );
    await controller.execute(
      'job-id',
      { batchSize: 50, idempotencyKey: 'batch:0001' },
      operator,
      request
    );

    expect(mocks.createRestoreJob).toHaveBeenCalledWith(restoreDto, operator, {
      requestId: request.requestId
    });
    expect(mocks.createCleanupJob).toHaveBeenCalledWith(cleanupDto, operator, {
      requestId: request.requestId
    });
    expect(mocks.decide).toHaveBeenCalledWith(
      'job-id',
      { decision: 'approved', reason: '同意执行' },
      operator,
      { requestId: request.requestId }
    );
    expect(mocks.execute).toHaveBeenCalledWith(
      'job-id',
      { batchSize: 50, idempotencyKey: 'batch:0001' },
      operator,
      { requestId: request.requestId }
    );
  });
});
