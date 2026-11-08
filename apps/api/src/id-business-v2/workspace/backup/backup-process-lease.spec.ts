import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { BackupProcessLease } from './backup-process-lease';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const directories: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true });
});
async function fixture() {
  const root = resolve(process.cwd(), '.runtime/backup-lease-tests');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, 'case-'));
  directories.push(dir);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    killed: false,
    kill: vi.fn()
  });
  vi.mocked(spawn).mockImplementation(() => {
    setImmediate(() => child.stdout.write('locked\n'));
    return child as never;
  });
  return { dir, child };
}
describe('exclusive backup guardian lifecycle', () => {
  it('requires a lock handshake and invalidates the lease when the guardian exits', async () => {
    const f = await fixture(),
      lease = await BackupProcessLease.acquire(f.dir);
    await expect(lease.assertCurrent()).resolves.toBeUndefined();
    f.child.exitCode = 1;
    f.child.emit('exit', 1);
    await expect(lease.assertCurrent()).rejects.toThrow('BACKUP_LOCK_LOST');
  });
  it('closes the guardian input on normal shutdown', async () => {
    const f = await fixture(),
      lease = await BackupProcessLease.acquire(f.dir);
    lease.close();
    expect(f.child.stdin.writableEnded).toBe(true);
    await expect(lease.assertCurrent()).rejects.toThrow('BACKUP_LOCK_LOST');
  });
  it('rejects a lock path that points outside the private outbox', async () => {
    const f = await fixture();
    await symlink(join(f.dir, 'other'), join(f.dir, '.uploader.lock'));
    await expect(BackupProcessLease.acquire(f.dir)).rejects.toThrow('BACKUP_LOCK_INVALID');
    expect(spawn).not.toHaveBeenCalled();
  });
});
