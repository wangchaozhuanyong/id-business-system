import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { BackupError } from './backup-types';

/** Shared by upload and verification downloads in the single backup executor. */
export class BackupTransferBudget {
  private nextAt = 0;
  constructor(
    readonly bytesPerSecond: number,
    private readonly now: () => number = () => performance.now(),
    private readonly wait: (milliseconds: number) => Promise<unknown> = sleep
  ) {
    if (
      !Number.isSafeInteger(bytesPerSecond) ||
      bytesPerSecond < 65_536 ||
      bytesPerSecond > 67_108_864
    )
      throw new BackupError('BACKUP_BANDWIDTH_CONFIG_INVALID');
  }
  async take(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 1_048_576)
      throw new BackupError('BACKUP_TRANSFER_CHUNK_INVALID');
    const delay = Math.max(0, this.nextAt - this.now());
    if (delay) await this.wait(delay);
    this.nextAt = Math.max(this.nextAt, this.now()) + (bytes / this.bytesPerSecond) * 1000;
  }
}
