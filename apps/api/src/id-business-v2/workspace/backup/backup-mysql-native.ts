import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable } from 'node:stream';
import { BackupError, UUID } from './backup-types';

export type MysqlBackupTool = 'mysql' | 'mysqldump' | 'mysqlbinlog';
/** Credentials belong to the launcher's protected defaults/environment, never argv or logs. */
export type MysqlBackupLauncher = (
  tool: MysqlBackupTool,
  args: readonly string[]
) => ChildProcessWithoutNullStreams;
export interface MysqlLogPosition {
  file: string;
  position: number;
}
const LOG_FILE = /^([A-Za-z0-9_-]+)\.(\d{6,})$/;
function checkPosition(value: MysqlLogPosition) {
  if (!LOG_FILE.test(value.file) || !Number.isSafeInteger(value.position) || value.position < 4)
    throw new BackupError('BACKUP_MYSQL_POSITION_INVALID');
}
export function mysqlPosition(value: MysqlLogPosition) {
  checkPosition(value);
  return `${value.file}:${value.position}`;
}

/** Bounded stderr is discarded; child failures cannot expose SQL or authentication details. */
function toolOutput(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
  let failed = false;
  const complete = new Promise<boolean>((resolve) => {
    child.once('error', () => {
      failed = true;
      resolve(false);
    });
    child.once('close', (code) => resolve(code === 0 && !failed));
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end();
  child.stderr.resume();
  const timer = setTimeout(() => {
    failed = true;
    child.kill('SIGKILL');
    child.stdout.destroy(new BackupError('BACKUP_MYSQL_TIMEOUT'));
  }, timeoutMs);
  const output = Readable.from(
    (async function* () {
      try {
        for await (const bytes of child.stdout) yield Buffer.from(bytes);
        if (!(await complete)) throw new BackupError('BACKUP_MYSQL_TOOL_FAILED');
      } catch {
        throw new BackupError('BACKUP_MYSQL_TOOL_FAILED');
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    })()
  );
  output.once('close', () => {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  return output;
}

export class MysqlNativeBackupSource {
  constructor(
    private readonly launch: MysqlBackupLauncher,
    private readonly timeoutMs = 15 * 60_000
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15 * 60_000)
      throw new BackupError('BACKUP_MYSQL_TIMEOUT_INVALID');
  }
  private output(tool: MysqlBackupTool, args: string[]) {
    try {
      return toolOutput(this.launch(tool, args), this.timeoutMs);
    } catch {
      throw new BackupError('BACKUP_MYSQL_TOOL_FAILED');
    }
  }
  private async query(sql: string) {
    const input = this.output('mysql', [
      '--batch',
      '--raw',
      '--skip-column-names',
      `--execute=${sql}`
    ]);
    const parts: Buffer[] = [];
    let size = 0;
    for await (const bytes of input) {
      size += bytes.length;
      if (size > 256 * 1024) {
        input.destroy();
        throw new BackupError('BACKUP_MYSQL_METADATA_TOO_LARGE');
      }
      parts.push(bytes);
    }
    return Buffer.concat(parts).toString('utf8').trim();
  }
  async serverUuid() {
    const value = await this.query('SELECT @@server_uuid');
    if (!UUID.test(value)) throw new BackupError('BACKUP_MYSQL_SERVER_INVALID');
    return value;
  }
  async position(): Promise<MysqlLogPosition> {
    const columns = (await this.query('SHOW BINARY LOG STATUS')).split('\t');
    const result = { file: columns[0]!, position: Number(columns[1]) };
    checkPosition(result);
    return result;
  }
  /** Caller must freeze DDL for the capture. Data writes continue under an InnoDB snapshot. */
  async full(database: string) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(database))
      throw new BackupError('BACKUP_MYSQL_DATABASE_INVALID');
    const serverUuid = await this.serverUuid();
    if (
      (await this.query(
        `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${database}' AND table_type='BASE TABLE' AND engine <> 'InnoDB'`
      )) !== '0'
    )
      throw new BackupError('BACKUP_MYSQL_NON_TRANSACTIONAL_TABLE');
    const input = this.output('mysqldump', [
      '--single-transaction',
      '--source-data=2',
      '--quick',
      '--routines',
      '--events',
      '--triggers',
      '--hex-blob',
      '--set-gtid-purged=OFF',
      '--no-tablespaces',
      '--default-character-set=utf8mb4',
      database
    ]);
    const iterator = input[Symbol.asyncIterator]();
    const prefix: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) throw new BackupError('BACKUP_MYSQL_COORDINATE_MISSING');
        prefix.push(Buffer.from(next.value));
        size += next.value.length;
        if (size > 256 * 1024) throw new BackupError('BACKUP_MYSQL_COORDINATE_MISSING');
        const match = Buffer.concat(prefix)
          .toString('utf8')
          .match(
            /-- CHANGE REPLICATION SOURCE TO SOURCE_LOG_FILE='([A-Za-z0-9_.-]+)', SOURCE_LOG_POS=(\d+);/
          );
        if (!match) continue;
        const coordinate = { file: match[1]!, position: Number(match[2]) };
        checkPosition(coordinate);
        return {
          serverUuid,
          coordinate,
          stream: Readable.from(
            (async function* () {
              try {
                yield* prefix;
                while (true) {
                  const chunk = await iterator.next();
                  if (chunk.done) break;
                  yield chunk.value;
                }
              } finally {
                input.destroy();
              }
            })()
          )
        };
      }
    } catch (error) {
      input.destroy();
      throw error;
    }
  }
  /** Uses actual server log inventory; missing/purged or non-contiguous files fail closed. */
  async incremental(
    start: MysqlLogPosition,
    end: MysqlLogPosition,
    expectedServer: string,
    database: string
  ) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(database))
      throw new BackupError('BACKUP_MYSQL_DATABASE_INVALID');
    checkPosition(start);
    checkPosition(end);
    if (!UUID.test(expectedServer) || (await this.serverUuid()) !== expectedServer)
      throw new BackupError('BACKUP_MYSQL_SERVER_CHANGED');
    const logs = (await this.query('SHOW BINARY LOGS')).split('\n').map((line) => {
      const [file, size] = line.split('\t');
      return { file: file!, size: Number(size) };
    });
    const first = logs.findIndex((log) => log.file === start.file);
    const last = logs.findIndex((log) => log.file === end.file);
    if (
      first < 0 ||
      last < first ||
      start.position > logs[first]!.size ||
      end.position > logs[last]!.size ||
      (first === last && end.position <= start.position)
    )
      throw new BackupError('BACKUP_MYSQL_LOG_GAP');
    const selected = logs.slice(first, last + 1);
    const reference = LOG_FILE.exec(start.file)!;
    if (
      selected.some((log, i) => {
        const match = LOG_FILE.exec(log.file);
        return !match || match[1] !== reference[1] || Number(match[2]) !== Number(reference[2]) + i;
      })
    )
      throw new BackupError('BACKUP_MYSQL_LOG_GAP');
    return this.output('mysqlbinlog', [
      '--read-from-remote-server',
      '--verify-binlog-checksum',
      '--require-row-format',
      '--skip-gtids',
      `--database=${database}`,
      `--start-position=${start.position}`,
      `--stop-position=${end.position}`,
      ...selected.map((log) => log.file)
    ]);
  }
}
