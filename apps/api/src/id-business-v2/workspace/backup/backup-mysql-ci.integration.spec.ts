import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ConfigService } from '@nestjs/config';
import { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import { NEW_SYSTEM_BACKUP_PROFILE } from '../id-business-v2-new-backup-coverage';
import { encryptBackupStream, decryptBackupFile } from './backup-envelope';
import {
  MysqlNativeBackupSource,
  mysqlPosition,
  type MysqlBackupLauncher
} from './backup-mysql-native';
import { BackupProcessLease } from './backup-process-lease';
import type { BackupIdentity } from './backup-types';
import { MysqlTriggerRestoreFilter } from './backup-mysql-restore-filter';
import { mysqlSchemaReceipts, mysqlSchemaDifferences } from './backup-mysql-schema-receipts';

const enabled = process.env.GITHUB_ACTIONS === 'true' && process.env.GOOGLE_BACKUP_MYSQL_CI === '1';
const suite = enabled ? describe : describe.skip;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fixtureDirectory = resolve(process.cwd(), '../../scripts/fixtures/google-backup-new-system');
const runtime = resolve(process.cwd(), '../../.runtime/google-backup-ci');
const database = 'id_backup_test_new_system';
const nativeExits: { tool: string; code: number | null; signal: string | null }[] = [];
const restoreFilters: { triggers: number; delimiterBlocks: number }[] = [];
function container(kind: 'SOURCE' | 'RESTORE') {
  const value = process.env[`BACKUP_CI_${kind}_CONTAINER`] ?? '';
  if (!/^id-backup-ci-(source|restore)-[0-9]+$/.test(value))
    throw new Error('CI_CONTAINER_INVALID');
  if (!process.env.MYSQL_PWD) throw new Error('CI_PASSWORD_MISSING');
  return value;
}
function launch(kind: 'SOURCE' | 'RESTORE'): MysqlBackupLauncher {
  return (tool, args) => {
    const child = spawn(
      'docker',
      ['exec', '-i', '-e', 'MYSQL_PWD', container(kind), tool, '--user=root', ...args],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    child.once('close', (code, signal) => nativeExits.push({ tool, code, signal }));
    return child;
  };
}
/** Preserve only structured failure codes; arbitrary SQL/stderr never leaves memory. */
function captureFailure(stream: NodeJS.ReadableStream, prefix: string) {
  let tail = '',
    safe = prefix;
  stream.on('data', (bytes: Buffer) => {
    tail = (tail + bytes.toString('utf8')).slice(-8192);
    const mysql = /ERROR (\d{3,5}) \(([A-Z0-9]{5})\)(?: at line (\d+))?/.exec(tail);
    const prisma = /\bP(\d{4})\b/.exec(tail);
    if (mysql) safe = `${prefix}_MYSQL_${mysql[1]}_${mysql[2]}_LINE_${mysql[3] ?? 0}`;
    else if (prisma) safe = `${prefix}_PRISMA_P${prisma[1]}`;
  });
  return () => safe;
}
async function command(command: string, args: string[], input?: string) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let size = 0;
  const parts: Buffer[] = [];
  const failure = captureFailure(child.stderr, 'CI_COMMAND_FAILED');
  child.stdin.on('error', () => undefined);
  child.stdin.end(input);
  const completed = new Promise<boolean>((resolve) => {
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
  for await (const chunk of child.stdout) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) {
      child.kill('SIGKILL');
      throw new Error('CI_OUTPUT_TOO_LARGE');
    }
    parts.push(chunk);
  }
  if (!(await completed)) throw new Error(failure());
  return Buffer.concat(parts).toString('utf8').trim();
}
async function sql(kind: 'SOURCE' | 'RESTORE', statement: string) {
  return command(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'MYSQL_PWD',
      container(kind),
      'mysql',
      '--user=root',
      '--default-character-set=utf8mb4',
      '--batch',
      '--raw',
      '--skip-column-names',
      database
    ],
    statement
  );
}
async function importSql(child: ChildProcessWithoutNullStreams, input: Readable) {
  const failure = captureFailure(child.stderr, 'CI_RESTORE_FAILED');
  child.stdout.resume();
  const complete = new Promise<boolean>((resolve) => {
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
  let transferFailed = false;
  const filter = new MysqlTriggerRestoreFilter();
  try {
    await pipeline(input, filter, child.stdin);
  } catch {
    transferFailed = true;
    child.stdin.destroy();
  }
  restoreFilters.push(filter.summary());
  if (!(await complete)) throw new Error(failure());
  if (transferFailed) throw new Error('CI_RESTORE_INPUT_FAILED');
}
async function restore(path: string) {
  return importSql(
    launch('RESTORE')('mysql', ['--default-character-set=utf8mb4', database]),
    createReadStream(path)
  );
}
function quoted(value: string) {
  return `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`;
}
function identifier(value: string) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error('CI_IDENTIFIER_INVALID');
  return '`' + value + '`';
}
function restoreContext(sqlText: string, line: number) {
  const lines = sqlText.split('\n');
  if (!Number.isSafeInteger(line) || line < 1 || line > lines.length) return { line, valid: false };
  let table = 'unknown',
    section = 'unknown';
  for (const text of lines.slice(0, line)) {
    const match = /^-- (Table structure|Dumping data) for table `([A-Za-z0-9_]+)`/.exec(text);
    if (match) {
      section = match[1]!;
      table = match[2]!;
    }
  }
  const keywords = new Set(
    'CREATE DROP ALTER TABLE TRIGGER BEFORE AFTER DELETE INSERT UPDATE ON FOR EACH ROW BEGIN END IF THEN SIGNAL SQLSTATE SET MESSAGE_TEXT NOT NULL AND OR IN VALUES PRIMARY KEY CONSTRAINT CHECK REFERENCES SELECT FROM WHERE DELIMITER DEFINER DEFAULT ENGINE VARCHAR CHAR TEXT DATETIME DECIMAL JSON INT INDEX UNIQUE CASE WHEN ELSE UNSIGNED'.split(
      ' '
    )
  );
  const shape = lines
    .slice(Math.max(0, line - 3), line + 40)
    .join('\n')
    .replace(/'(?:''|\\.|[^'\\])*'|"(?:""|\\.|[^"\\])*"|`(?:``|[^`])*`/g, '?')
    .replace(/[A-Za-z_][A-Za-z0-9_$]*/g, (word) =>
      keywords.has(word.toUpperCase()) ? word.toUpperCase() : '?'
    )
    .replace(/\d+/g, '#')
    .replace(/[^\x20-\x7E]/g, (character) => ('\t\n\r'.includes(character) ? character : '?'))
    .slice(0, 4000);
  return { line, valid: true, table, section, shape };
}
/** The database emits only fixed-size row digests; fixture ordering uses no MySQL filesort. */
function rowReceipts(output: string, names: string[]) {
  const hashes = names.map(() => [] as string[]);
  let current = -1;
  for (const line of output.split('\n')) {
    const marker = /^__TABLE_(\d+)__$/.exec(line);
    if (marker) {
      const next = Number(marker[1]);
      if (next !== current + 1 || next >= names.length) throw new Error('CI_SNAPSHOT_INVALID');
      current = next;
    } else if (current >= 0 && /^[a-f0-9]{64}$/.test(line)) hashes[current]!.push(line);
    else throw new Error('CI_SNAPSHOT_INVALID');
  }
  if (current !== names.length - 1) throw new Error('CI_SNAPSHOT_INCOMPLETE');
  return names.map((name, index) => ({
    name,
    rowCount: hashes[index]!.length,
    sha256: digest(hashes[index]!.sort().join('\n'))
  }));
}

describe('bounded recovery comparison receipts', () => {
  it('describes a failing SQL structure while removing quoted data and identifiers', () => {
    const context = restoreContext(
      "-- Dumping data for table `attachments`\nINSERT INTO `attachments` VALUES('synthetic-sensitive-value',12345);",
      2
    );
    expect(context.table).toBe('attachments');
    expect(context.shape).toContain('INSERT');
    expect(context.shape).not.toContain('synthetic-sensitive-value');
    expect(context.shape).not.toContain('12345');
    expect(restoreContext('SELECT 1', 999).valid).toBe(false);
  });
  it('preserves a client SQL error when early exit breaks the input pipe', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.stderr.write('ERROR 1452 (23000) at line 42: synthetic-sensitive-value\\n');process.exit(1)"
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    await expect(importSql(child, Readable.from([Buffer.alloc(2 * 1024 * 1024)]))).rejects.toThrow(
      'CI_RESTORE_FAILED_MYSQL_1452_23000_LINE_42'
    );
  });
  it('retains split error codes after many warnings without exposing raw stderr', () => {
    const stderr = new PassThrough(),
      failure = captureFailure(stderr, 'CI_RESTORE_FAILED');
    stderr.write('synthetic-sensitive-value\n'.repeat(2000));
    stderr.write('ERROR 1452 (230');
    stderr.write('00) at line 42: synthetic-sensitive-value\n');
    expect(failure()).toBe('CI_RESTORE_FAILED_MYSQL_1452_23000_LINE_42');
    stderr.end();
    const unknown = new PassThrough(),
      fallback = captureFailure(unknown, 'CI_RESTORE_FAILED');
    unknown.end('synthetic-sensitive-value');
    expect(fallback()).toBe('CI_RESTORE_FAILED');
  });
  it('compares unordered rows while retaining empty tables and duplicate counts', () => {
    const a = 'a'.repeat(64),
      b = 'b'.repeat(64),
      names = ['rows', 'empty'];
    const first = rowReceipts(`__TABLE_0__\n${a}\n${b}\n__TABLE_1__`, names);
    expect(rowReceipts(`__TABLE_0__\n${b}\n${a}\n__TABLE_1__`, names)).toEqual(first);
    expect(first.map(({ rowCount }) => rowCount)).toEqual([2, 0]);
    expect(rowReceipts(`__TABLE_0__\n${a}\n${b}\n${b}\n__TABLE_1__`, names)).not.toEqual(first);
  });
  it('rejects missing table boundaries and unexpected row payloads', () => {
    expect(() => rowReceipts('__TABLE_0__', ['one', 'two'])).toThrow('CI_SNAPSHOT_INCOMPLETE');
    expect(() => rowReceipts('__TABLE_1__', ['one', 'two'])).toThrow('CI_SNAPSHOT_INVALID');
    expect(() => rowReceipts('__TABLE_0__\nraw-synthetic-row', ['one'])).toThrow(
      'CI_SNAPSHOT_INVALID'
    );
  });
});

/** Exact null/value bytes for every scalar column and every row, including empty tables. */
async function snapshot(kind: 'SOURCE' | 'RESTORE') {
  const columns = await sql(
    kind,
    `SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=DATABASE() ORDER BY table_name,ordinal_position`
  );
  const tables = new Map<string, string[]>();
  for (const line of columns.split('\n')) {
    const [table, column] = line.split('\t');
    tables.set(table!, [...(tables.get(table!) ?? []), column!]);
  }
  const queries = [...tables].map(
    ([table, fields]) =>
      `SELECT SHA2(CONCAT_WS(',',${fields.map((field) => `IF(${identifier(field)} IS NULL,'N',CONCAT('H',HEX(CAST(${identifier(field)} AS BINARY))))`).join(',')}),256) FROM ${identifier(table)};`
  );
  // One native client keeps Docker startup out of the per-table comparison.
  const rows = await sql(kind, queries.map((q, i) => `SELECT '__TABLE_${i}__';\n${q}`).join('\n'));
  const receipts = rowReceipts(rows, [...tables.keys()]);
  const metadataQueries = [
    `SELECT table_name,table_type,engine,table_collation FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name`,
    `SELECT table_name,column_name,ordinal_position,column_type,is_nullable,HEX(column_default),extra,HEX(generation_expression),collation_name FROM information_schema.columns WHERE table_schema=DATABASE() ORDER BY table_name,ordinal_position`,
    `SELECT table_name,index_name,non_unique,seq_in_index,column_name,sub_part,index_type FROM information_schema.statistics WHERE table_schema=DATABASE() ORDER BY table_name,index_name,seq_in_index`,
    `SELECT table_name,constraint_name,constraint_type FROM information_schema.table_constraints WHERE table_schema=DATABASE() ORDER BY table_name,constraint_name`,
    `SELECT table_name,constraint_name,column_name,ordinal_position,referenced_table_name,referenced_column_name FROM information_schema.key_column_usage WHERE table_schema=DATABASE() ORDER BY table_name,constraint_name,ordinal_position`,
    `SELECT constraint_name,HEX(check_clause) FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() ORDER BY constraint_name`,
    `SELECT trigger_name,event_manipulation,event_object_table,action_order,HEX(action_statement),action_orientation,action_timing,definer FROM information_schema.triggers WHERE trigger_schema=DATABASE() ORDER BY trigger_name`,
    `SELECT routine_name,routine_type,data_type,HEX(routine_definition),is_deterministic,sql_data_access,security_type,definer FROM information_schema.routines WHERE routine_schema=DATABASE() ORDER BY routine_name`,
    `SELECT event_name,HEX(event_definition),event_type,interval_value,interval_field,status FROM information_schema.events WHERE event_schema=DATABASE() ORDER BY event_name`
  ];
  const metadata = await sql(
    kind,
    metadataQueries.map((q, i) => `SELECT '__OBJECT_${i}__';\n${q};`).join('\n')
  );
  return {
    tables: tables.size,
    columns: columns.split('\n').length,
    rowHash: digest(JSON.stringify(receipts)),
    tableReceipts: receipts,
    schemaHash: digest(metadata),
    schemaReceipts: mysqlSchemaReceipts(metadata)
  };
}

suite('new system native MySQL isolated recovery', () => {
  it('restores all tables/objects plus two real binlog segments across rotation and exact attachment bytes', async () => {
    const started = performance.now();
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    const temp = await mkdtemp(join(runtime, 'private-'));
    const report: Record<string, unknown> = {
      profile: NEW_SYSTEM_BACKUP_PROFILE,
      status: 'running',
      scope: 'fresh CI synthetic database only',
      checks: []
    };
    const checks = report.checks as string[];
    const schemaFailures: {
      stage: string;
      expectedHash: string;
      actualHash: string;
      differences: ReturnType<typeof mysqlSchemaDifferences>;
    }[] = [];
    nativeExits.length = 0;
    restoreFilters.length = 0;
    try {
      report.stage = 'tool-preflight';
      const versions = [];
      for (const tool of ['mysql', 'mysqldump', 'mysqlbinlog']) {
        const version = await command('docker', ['exec', container('SOURCE'), tool, '--version']);
        if (!/\b8\.4\.11\b/.test(version)) throw new Error('CI_MYSQL_TOOL_VERSION_MISMATCH');
        versions.push({ tool, version });
      }
      report.tools = versions;
      checks.push('all three native tools available and match pinned MySQL 8.4.11');
      report.stage = 'migrations';
      // Assemble reviewed schema input with unchanged existing migration chain in this private test tree.
      const fs = await import('node:fs/promises');
      const fixture = join(temp, 'schema');
      await fs.cp(resolve(process.cwd(), 'prisma-mysql/migrations'), join(fixture, 'migrations'), {
        recursive: true
      });
      await fs.cp(join(fixtureDirectory, 'migrations'), join(fixture, 'migrations'), {
        recursive: true
      });
      await fs.copyFile(join(fixtureDirectory, 'schema.prisma'), join(fixture, 'schema.prisma'));
      const connection = new URL(process.env.DATABASE_URL ?? '');
      if (connection.hostname !== '127.0.0.1' || connection.pathname !== `/${database}`)
        throw new Error('CI_DATABASE_INVALID');
      await command(resolve(process.cwd(), '../../node_modules/.bin/prisma'), [
        'migrate',
        'deploy',
        '--schema',
        join(fixture, 'schema.prisma')
      ]);
      checks.push('fresh schema applied via existing migrations plus seven new-version migrations');
      const codec = new FieldEncryptionService(
        new ConfigService({ FIELD_ENCRYPTION_KEY: randomBytes(32).toString('hex') })
      );
      const enc = (value: string) => quoted(codec.encrypt(value)!);
      const user = randomUUID(),
        customer = randomUUID(),
        order = randomUUID(),
        deleted = randomUUID(),
        card = randomUUID(),
        claudeOrder = randomUUID(),
        claudePerson = randomUUID();
      const attachment = randomBytes(128 * 1024 + 7),
        attachmentHash = digest(attachment);
      report.stage = 'fixture-inserts';
      await sql(
        'SOURCE',
        `SET NAMES utf8mb4;
        INSERT INTO users(id,username,password_hash,display_name,updated_at) VALUES('${user}','ci-backup-fixture','synthetic-non-login-hash','隔离验证员工',NOW(6));
        INSERT INTO id_business_v2_customers(id,name,phone_encrypted,phone_search_tokens,wechat_search_tokens,qq_search_tokens,whatsapp_search_tokens,updated_at) VALUES('${customer}','隔离客户中文🙂',${enc('synthetic-phone')},JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),NOW(6)),('${deleted}','待删除的隔离客户',NULL,JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),NOW(6));
        INSERT INTO id_business_v2_inventory_options(id,scope,kind,name,normalized_name,parent_id,parent_key,updated_at) VALUES
          ('ci_source','google_mailbox','source','隔离来源','隔离来源',NULL,'',NOW(6)),
          ('ci_category','mail_category','category','隔离分类','隔离分类',NULL,'',NOW(6)),
          ('ci_country','claude_account','country','隔离国家','隔离国家',NULL,'',NOW(6)),
          ('ci_city','claude_account','city','隔离城市','隔离城市','ci_country','ci_country',NOW(6));
        INSERT INTO id_business_v2_google_mailboxes(id,email_encrypted,email_hash,password_encrypted,source_option_id,phone_unbound_confirmed,updated_at) VALUES('ci_mail',${enc('ci@example.invalid')},'${digest('ci-mail')}',${enc('synthetic-password')},'ci_source',TRUE,NOW(6));
        INSERT INTO id_business_v2_claude_accounts(id,email_encrypted,email_hash,password_encrypted,mail_category_option_id,country_option_id,city_option_id,updated_at) VALUES('ci_claude',${enc('claude@example.invalid')},'${digest('ci-claude')}',${enc('synthetic-claude-password')},'ci_category','ci_country','ci_city',NOW(6));
        INSERT INTO id_business_v2_bank_recharge_currencies(code,name,minor_units,updated_at) VALUES('USD','隔离美元',2,NOW(6)) ON DUPLICATE KEY UPDATE name=VALUES(name);
        INSERT INTO id_business_v2_bank_recharge_cards(id,label,last4,currency_code,updated_at) VALUES('${card}','隔离卡片，无真实付款','0000','USD',NOW(6));
        INSERT INTO id_business_v2_subscription_orders(id,order_no,plan,business_type,customer_id,customer_snapshot_encrypted,account_email_encrypted,account_email_hash,account_email_search_tokens,card_id,card_last6,paid_amount,paid_currency,sale_amount,sale_currency,opened_at,due_at,paid_confirmed,receipt_confirmed,cost_confirmed,financial_snapshot,request_hash,idempotency_key,created_by_user_id,updated_at)
          VALUES('${order}','CI-BACKUP-1','plus','renewal','${customer}',${enc('synthetic-customer-snapshot')},${enc('ci@example.invalid')},'${digest('order-mail')}',JSON_ARRAY(),'${card}','000000',19.1234,'USD',140.9876,'CNY','2026-11-01','2026-12-01',true,true,true,JSON_OBJECT('fxRate','7.12345678','fee','0.0001'),'${digest('request')}','ci-backup-order','${user}',NOW(6));
        INSERT INTO attachments(id,original_name,storage_key,mime_type,size_bytes,content_encrypted,content_sha256,object_id) VALUES('${randomUUID()}','隔离附件.bin','ci/fixture.bin','application/octet-stream',${attachment.length},${enc(attachment.toString('base64'))},'${attachmentHash}','${order}');`
      );
      report.stage = 'subscription-material-fixture';
      await sql(
        'SOURCE',
        `INSERT INTO id_business_v2_claude_pro_people(id,kind,name,phone_encrypted,phone_hash,request_hash,idempotency_key,created_by_user_id)
          VALUES('${claudePerson}','owner','隔离人员',${enc('synthetic-person-phone')},'${digest('ci-person-phone')}','${digest('ci-person-request')}','ci-backup-person','${user}');
        INSERT INTO id_business_v2_subscription_orders(id,order_no,product,plan,business_type,customer_id,customer_snapshot_encrypted,account_email_encrypted,account_email_hash,account_email_search_tokens,claude_pro_mode,claude_pro_people_encrypted,paid_amount,paid_currency,sale_amount,sale_currency,opened_at,due_at,paid_confirmed,receipt_confirmed,cost_confirmed,financial_snapshot,request_hash,idempotency_key,created_by_user_id,updated_at)
          SELECT '${claudeOrder}','CI-BACKUP-CLAUDE','claude','claude_pro',business_type,customer_id,customer_snapshot_encrypted,${enc('claude-order@example.invalid')},'${digest('claude-order-mail')}',JSON_ARRAY(),'people',${enc(JSON.stringify({ personId: claudePerson, detail: '隔离人员资料' }))},paid_amount,paid_currency,sale_amount,sale_currency,opened_at,due_at,paid_confirmed,receipt_confirmed,cost_confirmed,financial_snapshot,'${digest('claude-order-request')}','ci-backup-claude-order',created_by_user_id,NOW(6)
          FROM id_business_v2_subscription_orders WHERE id='${order}';`
      );
      await sql(
        'SOURCE',
        `CREATE DATABASE id_backup_test_other; CREATE TABLE id_backup_test_other.sentinel(id INT PRIMARY KEY);`
      );
      checks.push('four modules seeded with valid relations and encrypted synthetic fields');
      report.stage = 'added-column-fixture';
      // CI-only DDL: prove native export follows the actual DB, beyond the compiled ORM metadata.
      await sql(
        'SOURCE',
        `ALTER TABLE id_business_v2_customers ADD COLUMN ci_schema_added_note VARCHAR(128) NULL;
        UPDATE id_business_v2_customers SET ci_schema_added_note='新增字段完整备份' WHERE id='${customer}';`
      );
      report.stage = 'source-baseline';
      const baseline = await snapshot('SOURCE');
      expect(baseline.tables).toBe(119); // 118 application models + actual _prisma_migrations.
      expect(baseline.tableReceipts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'id_business_v2_claude_pro_people', rowCount: 1 }),
          expect.objectContaining({
            name: 'id_business_v2_claude_pro_order_revisions',
            rowCount: 0
          }),
          expect.objectContaining({ name: 'id_business_v2_subscription_orders', rowCount: 2 })
        ])
      );
      checks.push('source baseline covers every physical table including migration history');
      report.stage = 'full-and-incremental-capture';
      const native = new MysqlNativeBackupSource(launch('SOURCE'), 120_000);
      const capture = await native.full(database);
      const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
      const base: BackupIdentity = {
        profile: NEW_SYSTEM_BACKUP_PROFILE,
        id: randomUUID(),
        sourceId: randomUUID(),
        kind: 'full',
        schemaSha256: digest(await readFile(join(fixtureDirectory, 'schema.prisma'))),
        boundary: {
          stream: `mysql:${capture.serverUuid}`,
          start: mysqlPosition(capture.coordinate),
          end: mysqlPosition(capture.coordinate)
        }
      };
      // Writes after the snapshot coordinate must be absent from the full and present after replay.
      const fullPromise = encryptBackupStream(capture.stream, temp, base, keys.publicKey);
      await sql(
        'SOURCE',
        `START TRANSACTION;
        UPDATE id_business_v2_customers SET name='增量客户一🙂',updated_at=NOW(6) WHERE id='${customer}';
        UPDATE id_business_v2_customers SET ci_schema_added_note='新增字段增量修改' WHERE id='${customer}';
        UPDATE id_business_v2_google_mailboxes SET password_encrypted=${enc('changed-password')},version=2 WHERE id='ci_mail';
        INSERT INTO id_backup_test_other.sentinel VALUES(1);
        COMMIT;`
      );
      const full = await fullPromise;
      checks.push(
        'native consistent full dump streamed directly into encrypted and hashed envelope'
      );
      report.stage = 'incremental-1-capture';
      const firstEnd = await native.position();
      const first: BackupIdentity = {
        ...base,
        id: randomUUID(),
        kind: 'incremental',
        previousId: base.id,
        boundary: {
          ...base.boundary!,
          start: mysqlPosition(capture.coordinate),
          end: mysqlPosition(firstEnd)
        }
      };
      const increment1 = await encryptBackupStream(
        await native.incremental(capture.coordinate, firstEnd, capture.serverUuid, database),
        temp,
        first,
        keys.publicKey
      );
      const afterFirst = await snapshot('SOURCE');
      checks.push('first incremental segment captured and encrypted');
      report.stage = 'incremental-2-capture';
      await sql(
        'SOURCE',
        `FLUSH BINARY LOGS;
        START TRANSACTION;
        DELETE FROM id_business_v2_customers WHERE id='${deleted}';
        UPDATE id_business_v2_subscription_orders SET paid_amount=19.1235,version=2 WHERE id='${order}';
        UPDATE id_business_v2_subscription_orders SET claude_pro_people_encrypted=${enc(JSON.stringify({ personId: claudePerson, detail: '隔离修订资料' }))},version=2 WHERE id='${claudeOrder}';
        INSERT INTO id_business_v2_claude_pro_order_revisions(id,order_id,from_version,to_version,before_encrypted,after_encrypted,reason_encrypted,idempotency_key,request_hash,operator_user_id)
          VALUES('${randomUUID()}','${claudeOrder}',1,2,${enc('隔离变更前')},${enc('隔离变更后')},${enc('隔离变更原因')},'ci-backup-claude-revision','${digest('ci-backup-claude-revision')}','${user}');
        UPDATE id_business_v2_claude_accounts SET remark1='增量二跨日志文件',version=2 WHERE id='ci_claude';
        COMMIT;`
      );
      const lastEnd = await native.position();
      expect(lastEnd.file).not.toBe(firstEnd.file);
      const second: BackupIdentity = {
        ...base,
        id: randomUUID(),
        kind: 'incremental',
        previousId: first.id,
        boundary: { ...base.boundary!, start: mysqlPosition(firstEnd), end: mysqlPosition(lastEnd) }
      };
      const increment2 = await encryptBackupStream(
        await native.incremental(firstEnd, lastEnd, capture.serverUuid, database),
        temp,
        second,
        keys.publicKey
      );
      const final = await snapshot('SOURCE');
      expect(final.tableReceipts).toContainEqual(
        expect.objectContaining({ name: 'id_business_v2_claude_pro_order_revisions', rowCount: 1 })
      );
      checks.push('second incremental segment captured across rotation and encrypted');
      const restoredStages: {
        kind: BackupIdentity['kind'];
        tables: number;
        columns: number;
        rowDataMatched: boolean;
        schemaMatched: boolean;
      }[] = [];
      report.restoredStages = restoredStages;
      for (const [blob, identity, expected] of [
        [full, base, baseline],
        [increment1, first, afterFirst],
        [increment2, second, final]
      ] as const) {
        report.stage = `restore-${identity.kind}-${identity.id}`;
        const output = join(temp, `${identity.id}.restore.sql`);
        await decryptBackupFile(join(temp, blob.filename), output, keys.privateKey, identity);
        expect((await readFile(output, 'utf8')).includes('id_backup_test_other')).toBe(false);
        try {
          await restore(output);
        } catch (error) {
          const match = /_LINE_(\d+)$/.exec(error instanceof Error ? error.message : '');
          if (match)
            report.restoreContext = restoreContext(
              await readFile(output, 'utf8'),
              Number(match[1])
            );
          throw error;
        }
        const observed = await snapshot('RESTORE');
        const {
          schemaReceipts: sourceReceipts,
          schemaHash: expectedSchema,
          ...expectedValues
        } = expected;
        const {
          schemaReceipts: restoredReceipts,
          schemaHash: restoredSchema,
          ...restoredValues
        } = observed;
        if (restoredSchema !== expectedSchema) {
          schemaFailures.push({
            stage: `${identity.kind}:${identity.id}`,
            expectedHash: expectedSchema,
            actualHash: restoredSchema,
            differences: mysqlSchemaDifferences(sourceReceipts, restoredReceipts)
          });
          report.schemaDifferences = schemaFailures;
        }
        expect(restoredValues).toEqual(expectedValues);
        expect(
          await sql(
            'RESTORE',
            `SELECT ci_schema_added_note FROM id_business_v2_customers WHERE id='${customer}'`
          )
        ).toBe(identity.kind === 'full' ? '新增字段完整备份' : '新增字段增量修改');
        restoredStages.push({
          kind: identity.kind,
          tables: observed.tables,
          columns: observed.columns,
          rowDataMatched: true,
          schemaMatched: restoredSchema === expectedSchema
        });
        await rm(output);
      }
      checks.push(
        'full snapshot excludes concurrent later writes; both transaction segments replay exactly across log rotation'
      );
      checks.push('row-format database filter excludes another synthetic project database');
      checks.push(
        'a newly added physical column and its later changes restore without an ORM field mapping'
      );
      checks.push(
        'all table/column counts and row digests match at every step; schema verification is separate'
      );
      checks.push('new encrypted subscription materials and correction history match');
      report.stage = 'attachment-and-function-verification';
      expect(
        await sql(
          'RESTORE',
          "SELECT idv2_integrity_trigger_exists('idv2_account_loss_no_delete','id_business_v2_account_losses')"
        )
      ).toBe('1');
      expect(
        await sql(
          'RESTORE',
          `SELECT paid_amount FROM id_business_v2_subscription_orders WHERE id='${order}'`
        )
      ).toBe('19.1235');
      const encryptedAttachment = await sql(
        'RESTORE',
        `SELECT content_encrypted FROM attachments LIMIT 1`
      );
      expect(digest(Buffer.from(codec.decrypt(encryptedAttachment)!, 'base64'))).toBe(
        attachmentHash
      );
      const attachmentSource = join(temp, 'synthetic-attachment.bin');
      await writeFile(attachmentSource, attachment, { mode: 0o600 });
      const attachmentIdentity: BackupIdentity = { ...base, id: randomUUID(), kind: 'attachments' };
      const fileBlob = await encryptBackupStream(
        createReadStream(attachmentSource),
        temp,
        attachmentIdentity,
        keys.publicKey
      );
      const fileRestored = join(temp, 'attachment.restored');
      await decryptBackupFile(
        join(temp, fileBlob.filename),
        fileRestored,
        keys.privateKey,
        attachmentIdentity
      );
      expect(digest(await readFile(fileRestored))).toBe(attachmentHash);
      checks.push(
        'Decimal precision, encrypted database attachment and standalone binary attachment match'
      );
      report.stage = 'native-linux-lock';
      const leaseDirectory = join(temp, 'lease');
      const lock = await BackupProcessLease.acquire(leaseDirectory);
      await expect(BackupProcessLease.acquire(leaseDirectory)).rejects.toThrow(
        'BACKUP_LOCK_UNAVAILABLE'
      );
      lock.close();
      let reacquired = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        try {
          const next = await BackupProcessLease.acquire(leaseDirectory);
          await next.assertCurrent();
          next.close();
          reacquired = true;
          break;
        } catch {
          /* OS child may still be exiting. */
        }
      }
      expect(reacquired).toBe(true);
      checks.push('real Linux flock rejects second process and releases after close');
      report.stage = 'schema-verification';
      expect(schemaFailures).toEqual([]); // Defer failure reporting, never relax the success criterion.
      checks.push('all physical schema fingerprints match after each restore step');
      report.status = 'passed';
      report.stage = 'complete';
      report.snapshot = final;
      report.elapsedMs = Math.round(performance.now() - started);
      report.cloudUpload =
        'protocol faults tested separately with mocked Drive; no live Google write';
      report.performance = 'native fixture duration only; production website p95 not measured';
    } catch (error) {
      report.status = 'failed';
      report.error =
        error instanceof Error
          ? error.message.replace(/mysql:\/\/\S+/g, '[redacted]')
          : 'CI_FAILED';
      throw error;
    } finally {
      report.nativeExits = nativeExits;
      report.restoreFilters = restoreFilters;
      await writeFile(join(runtime, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
        mode: 0o600
      });
      await rm(temp, { recursive: true, force: true });
    }
  }, 240_000);
});
