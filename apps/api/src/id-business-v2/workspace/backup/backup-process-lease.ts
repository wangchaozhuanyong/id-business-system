import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { lstat, open } from 'node:fs/promises';
import { BackupError, type BackupLease } from './backup-types';
import { privateBackupDirectory } from './backup-files';

/** Linux worker only. The OS releases flock when the guardian/parent exits. */
export class BackupProcessLease implements BackupLease {
  private held = false;
  private constructor(private readonly child: ChildProcessWithoutNullStreams) {}
  static async acquire(directory: string) {
    await privateBackupDirectory(directory);
    const path = join(directory, '.uploader.lock');
    try {
      const file = await open(path, 'wx', 0o600);
      await file.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new BackupError('BACKUP_LOCK_INVALID');
    const child = spawn('flock', ['-n', path, 'sh', '-c', 'printf "locked\\n"; read release'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const lease = new BackupProcessLease(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.stdin.end();
        child.kill();
        reject(new BackupError('BACKUP_LOCK_TIMEOUT'));
      }, 5000);
      let output = '';
      const fail = () => {
        lease.held = false;
        child.stdin.end();
        clearTimeout(timer);
        reject(new BackupError('BACKUP_LOCK_UNAVAILABLE'));
      };
      child.once('error', fail);
      child.once('exit', fail);
      child.stdout.on('data', (bytes: Buffer) => {
        output += bytes.toString('utf8');
        if (output.length > 32) {
          child.kill();
          fail();
        } else if (output === 'locked\n') {
          clearTimeout(timer);
          lease.held = true;
          resolve();
        }
      });
      child.stderr.resume();
    });
    return lease;
  }
  async assertCurrent() {
    if (!this.held || this.child.exitCode !== null || this.child.killed)
      throw new BackupError('BACKUP_LOCK_LOST');
  }
  close() {
    this.held = false;
    this.child.stdin.end();
  }
}
