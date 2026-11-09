import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  MysqlNativeBackupSource,
  mysqlPosition,
  type MysqlBackupLauncher
} from './backup-mysql-native';

const server = '39b14fc7-50cd-4653-bd28-cbc70074ed8e';
function launcher(reply: (tool: string, args: readonly string[]) => string) {
  return vi.fn<MysqlBackupLauncher>((tool, args) =>
    spawn(process.execPath, ['-e', reply(tool, args)], { stdio: ['pipe', 'pipe', 'pipe'] })
  );
}
const print = (value: string) => `process.stdout.write(${JSON.stringify(value)})`;
const header =
  "-- CHANGE REPLICATION SOURCE TO SOURCE_LOG_FILE='backup-bin.000001', SOURCE_LOG_POS=157;\n";
const queryReply = (args: readonly string[]) =>
  args.some((arg) => arg.includes('server_uuid')) ? server : '0';

describe('native MySQL encrypted backup source', () => {
  it('starts a capture only from the migrated new system with complete row binlogs', async () => {
    const base = `applied\t${'a'.repeat(64)}\t20261108120000_claude_pro_order_materials`;
    const revision = (format: string, history: string) =>
      new MysqlNativeBackupSource(launcher(() => print(`${format}\n${history}`))).migrationRevision(
        'id_backup_test_fixture'
      );
    expect(await revision('1\tROW\tFULL', base)).toMatch(/^[a-f0-9]{64}$/);
    await expect(revision('1\tROW\tMINIMAL', base)).rejects.toThrow(
      'BACKUP_MYSQL_LOG_FORMAT_INVALID'
    );
    await expect(revision('1\tROW\tFULL', base.replace('applied', 'pending'))).rejects.toThrow(
      'BACKUP_MYSQL_MIGRATION_UNAVAILABLE'
    );
    await expect(
      revision(
        '1\tROW\tFULL',
        base.replace('20261108120000_claude_pro_order_materials', '20260821000000_baseline')
      )
    ).rejects.toThrow('BACKUP_MYSQL_NEW_VERSION_REQUIRED');
  });
  it('gets the consistent coordinate from the dump header and retains the exact stream', async () => {
    const launch = launcher((tool, args) =>
      print(tool === 'mysqldump' ? header + 'synthetic SQL\n' : queryReply(args))
    );
    const capture = await new MysqlNativeBackupSource(launch).full('id_backup_test_fixture');
    expect(capture.serverUuid).toBe(server);
    expect(mysqlPosition(capture.coordinate)).toBe('backup-bin.000001:157');
    const bytes: Buffer[] = [];
    for await (const chunk of capture.stream) bytes.push(chunk);
    expect(Buffer.concat(bytes).toString()).toBe(header + 'synthetic SQL\n');
    const args = launch.mock.calls.find(([tool]) => tool === 'mysqldump')![1];
    expect(args).toEqual(
      expect.arrayContaining([
        '--single-transaction',
        '--source-data=2',
        '--routines',
        '--events',
        '--triggers',
        '--hex-blob'
      ])
    );
  });
  it('rejects missing coordinates and subprocess errors without exposing stderr', async () => {
    const launch = launcher((tool, args) =>
      tool === 'mysqldump'
        ? "process.stderr.write('synthetic-sensitive-stderr');process.exit(2)"
        : print(queryReply(args))
    );
    await expect(
      new MysqlNativeBackupSource(launch).full('id_backup_test_fixture')
    ).rejects.toThrow('BACKUP_MYSQL_TOOL_FAILED');
    const missing = launcher((tool, args) =>
      print(tool === 'mysqldump' ? 'no coordinate' : queryReply(args))
    );
    await expect(
      new MysqlNativeBackupSource(missing).full('id_backup_test_fixture')
    ).rejects.toThrow('BACKUP_MYSQL_COORDINATE_MISSING');
  });
  it('rejects non-transactional tables before starting a dump', async () => {
    const launch = launcher((_tool, args) =>
      print(args.some((arg) => arg.includes('server_uuid')) ? server : '1')
    );
    await expect(
      new MysqlNativeBackupSource(launch).full('id_backup_test_fixture')
    ).rejects.toThrow('BACKUP_MYSQL_NON_TRANSACTIONAL_TABLE');
    expect(launch.mock.calls.some(([tool]) => tool === 'mysqldump')).toBe(false);
  });
  it('uses only contiguous server log files and refuses purged logs or changed server identity', async () => {
    const launch = launcher((tool, args) =>
      print(
        tool === 'mysqlbinlog'
          ? 'synthetic-binlog'
          : args.some((arg) => arg.includes('server_uuid'))
            ? server
            : args.some((arg) => arg.includes('log_bin_basename'))
              ? '/var/lib/mysql/backup-bin'
              : 'backup-bin.000001\t500\tNo\nbackup-bin.000002\t400\tNo'
      )
    );
    const source = new MysqlNativeBackupSource(launch);
    const stream = await source.incremental(
      { file: 'backup-bin.000001', position: 157 },
      { file: 'backup-bin.000002', position: 300 },
      server,
      'id_backup_test_fixture'
    );
    for await (const chunk of stream) expect(chunk.toString()).toBe('synthetic-binlog');
    expect(launch.mock.calls.find(([tool]) => tool === 'mysqlbinlog')![1]).toEqual(
      expect.arrayContaining([
        '--start-position=157',
        '--stop-position=300',
        '--database=id_backup_test_fixture',
        '--require-row-format',
        '/var/lib/mysql/backup-bin.000001',
        '/var/lib/mysql/backup-bin.000002'
      ])
    );
    expect(launch.mock.calls.find(([tool]) => tool === 'mysqlbinlog')![1]).not.toContain(
      '--read-from-remote-server'
    );
    await expect(
      source.incremental(
        { file: 'backup-bin.000000', position: 157 },
        { file: 'backup-bin.000002', position: 300 },
        server,
        'id_backup_test_fixture'
      )
    ).rejects.toThrow('BACKUP_MYSQL_LOG_GAP');
    await expect(
      source.incremental(
        { file: 'backup-bin.000001', position: 157 },
        { file: 'backup-bin.000002', position: 300 },
        '60fe1980-dbb9-45c8-a24e-776cdca05fdc',
        'id_backup_test_fixture'
      )
    ).rejects.toThrow('BACKUP_MYSQL_SERVER_CHANGED');
  });
  it('terminates stalled native children with a safe error', async () => {
    const launch = launcher(() => 'setInterval(()=>{},1000)');
    await expect(new MysqlNativeBackupSource(launch, 100).serverUuid()).rejects.toThrow(
      'BACKUP_MYSQL_TOOL_FAILED'
    );
  });
  it('refuses a nonlocal or mismatching binary-log path before reading files', async () => {
    for (const path of [
      '../backup-bin',
      '/var/lib/mysql/../backup-bin',
      '/var/lib/mysql/another-bin'
    ]) {
      const launch = launcher((_tool, args) =>
        print(
          args.some((arg) => arg.includes('server_uuid'))
            ? server
            : args.some((arg) => arg.includes('log_bin_basename'))
              ? path
              : 'backup-bin.000001\t500\tNo'
        )
      );
      await expect(
        new MysqlNativeBackupSource(launch).incremental(
          { file: 'backup-bin.000001', position: 157 },
          { file: 'backup-bin.000001', position: 300 },
          server,
          'id_backup_test_fixture'
        )
      ).rejects.toThrow('BACKUP_MYSQL_LOG_PATH_INVALID');
      expect(launch.mock.calls.some(([tool]) => tool === 'mysqlbinlog')).toBe(false);
    }
  });
});
