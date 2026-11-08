import { describe, expect, it } from 'vitest';
import { BackupTransferBudget } from './backup-transfer-budget';

describe('backup transfer budget', () => {
  it('paces consecutive upload and download chunks with the same monotonic budget', async () => {
    let clock = 0;
    const waits: number[] = [];
    const budget = new BackupTransferBudget(
      2 * 1024 * 1024,
      () => clock,
      async (value) => {
        waits.push(value);
        clock += value;
      }
    );
    await budget.take(1024 * 1024);
    await budget.take(1024 * 1024);
    await budget.take(512 * 1024);
    expect(waits).toEqual([500, 500]);
    clock += 5000;
    await budget.take(1024 * 1024);
    expect(waits).toHaveLength(2);
  });
  it('rejects unsafe rates and unbounded chunks instead of sleeping for an unbounded time', async () => {
    expect(() => new BackupTransferBudget(0)).toThrow('BACKUP_BANDWIDTH_CONFIG_INVALID');
    const budget = new BackupTransferBudget(65_536);
    await expect(budget.take(8 * 1024 * 1024)).rejects.toThrow('BACKUP_TRANSFER_CHUNK_INVALID');
  });
});
