import { gzipSync, gunzipSync } from 'node:zlib';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rm, lstat, statfs, mkdtemp, readdir } from 'node:fs/promises';
import {
  MAX_BYTES,
  NativeMysqlError,
  requireValue,
  sha256,
  identifier,
  privateBytes,
  projectDirectory,
  exclusivePrivateWrite,
  mysqlTools,
  configuredConnection,
  sql,
  run,
  ownedInstance,
  startIsolatedMysql,
  definitionSnapshot,
  requireCoreSnapshot,
  normalizeDump,
  checkTables,
  coreRestoreProtection
} from './lib/native-mysql-tools.mjs';

const MAGIC = 'IDV2_NATIVE_MYSQL_BACKUP_V1';
const canonical = (value) => JSON.stringify(value);
const exactKeys = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export function parseArgs(values) {
  const commands = new Set(['check', 'preflight', 'backup', 'verify', 'fixture-smoke']);
  const command = values[0] && !values[0].startsWith('--') ? values.shift() : 'check';
  requireValue(commands.has(command), 'COMMAND_INVALID');
  const names = {
    'bin-dir': 'binDirectory',
    'defaults-file': 'defaultsFile',
    database: 'database',
    'output-directory': 'outputDirectory',
    'work-directory': 'workDirectory',
    archive: 'archive',
    'key-file': 'keyFile',
    's3-bucket': 's3Bucket',
    's3-prefix': 's3Prefix',
    's3-region': 's3Region'
  };
  const options = { command };
  for (let i = 0; i < values.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(values[i]);
    requireValue(match && names[match[1]], 'OPTION_INVALID');
    const value = match[2] ?? values[++i];
    const key = names[match[1]];
    requireValue(
      value && !value.startsWith('--') && !Object.hasOwn(options, key),
      'OPTION_INVALID'
    );
    options[key] = value;
  }
  requireValue(
    command !== 'verify' ||
      !['defaultsFile', 'database', 'outputDirectory', 's3Bucket', 's3Prefix', 's3Region'].some(
        (key) => Object.hasOwn(options, key)
      ),
    'RESTORE_TARGET_OPTIONS_FORBIDDEN'
  );
  requireValue(command !== 'backup' || !options.archive, 'OPTION_INVALID');
  requireValue(
    command !== 'fixture-smoke' ||
      Object.keys(options).every((key) =>
        ['command', 'binDirectory', 'workDirectory'].includes(key)
      ),
    'FIXTURE_SOURCE_OPTIONS_FORBIDDEN'
  );
  return options;
}
export async function encryptionKey(path) {
  const raw = await privateBytes(path, 128);
  try {
    if (raw.length === 32) return Buffer.from(raw);
    const text = raw.toString().trim();
    requireValue(/^[a-fA-F0-9]{64}$/.test(text), 'KEY_MUST_BE_256_BITS');
    return Buffer.from(text, 'hex');
  } finally {
    raw.fill(0);
  }
}
export function dumpArguments(connection, database) {
  identifier(database);
  return [
    ...connection.args,
    '--init-command=SET SESSION TRANSACTION READ ONLY',
    '--single-transaction',
    '--quick',
    '--hex-blob',
    '--no-tablespaces',
    '--skip-lock-tables',
    '--set-gtid-purged=OFF',
    '--routines',
    '--events',
    '--triggers',
    '--column-statistics=0',
    '--default-character-set=utf8mb4',
    database
  ];
}
export function s3Preparation(options, path, bytes) {
  if (!options.s3Bucket) {
    requireValue(!options.s3Prefix && !options.s3Region, 'S3_PLAN_INCOMPLETE');
    return null;
  }
  const { s3Bucket, s3Prefix = 'mysql/native', s3Region = 'ap-northeast-1' } = options;
  requireValue(
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s3Bucket) &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s3Prefix) &&
      !s3Prefix.split('/').includes('..') &&
      /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(s3Region),
    'S3_PLAN_INVALID'
  );
  return {
    status: 'PREPARED_NOT_EXECUTED',
    objectEncryption: 'AES256',
    putObject: {
      Bucket: s3Bucket,
      Key: s3Prefix.replace(/\/$/, '') + '/' + path.split('/').at(-1),
      ServerSideEncryption: 'AES256',
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: Buffer.from(sha256(bytes), 'hex').toString('base64'),
      ContentLength: bytes.length
    },
    headObject: {
      checksumMode: 'ENABLED',
      requireEncryption: 'AES256',
      requireSize: bytes.length,
      requireSHA256: sha256(bytes)
    },
    retention: {
      count: 48,
      maxBytes: 1073741824,
      minimumFreeBytes: 2147483648,
      status: 'POLICY_PREPARED_NOT_APPLIED'
    }
  };
}
export async function preflight(options) {
  const tools = options.binDirectory ? await mysqlTools(options.binDirectory) : null;
  if (options.defaultsFile) await configuredConnection(options.defaultsFile);
  if (options.database) identifier(options.database);
  if (options.keyFile) (await encryptionKey(options.keyFile)).fill(0);
  if (options.outputDirectory) await projectDirectory(options.outputDirectory);
  if (options.workDirectory) await projectDirectory(options.workDirectory);
  if (options.archive) await privateBytes(options.archive, 2 * MAX_BYTES);
  return {
    status: 'PREFLIGHT_ONLY',
    mysqlVersion: tools?.version ?? 'NOT_MEASURED',
    binaryConfiguration: tools
      ? 'EXPLICIT_BIN_DIRECTORY_VERIFIED'
      : 'EXPLICIT_BIN_DIRECTORY_REQUIRED',
    databaseConnected: false,
    sourceMutated: false,
    restoreStarted: false,
    dockerUsed: false,
    awsCalled: false,
    userDataEncryptionRequired: true,
    operatorPrivateDefaultsRequired: true,
    restoreTarget: 'NEW_OWNED_DATADIR_PRIVATE_UNIX_SOCKET_TCP_OFF',
    sourceSessionReadOnly: 'ENFORCED_ON_BACKUP',
    productionAcceptance: 'NOT_MEASURED',
    s3: 'PARAMETERS_ONLY_NO_UPLOAD_NO_RETENTION_CLEANUP',
    dumpMemoryLimitBytes: MAX_BYTES
  };
}
function validateSnapshot(snapshot) {
  requireValue(
    exactKeys(snapshot, ['rows', 'sha256', 'counts']) &&
      Array.isArray(snapshot.rows) &&
      snapshot.rows.length <= 10000 &&
      sha256(canonical(snapshot.rows)) === snapshot.sha256 &&
      exactKeys(snapshot.counts, ['S', 'T', 'F', 'E', 'V']),
    'ARCHIVE_METADATA_INVALID'
  );
  const seen = new Set();
  for (const row of snapshot.rows) {
    requireValue(
      Array.isArray(row) &&
        row.length === 3 &&
        /^[STFEV]$/.test(row[0]) &&
        /^[A-Za-z0-9_]{1,64}$/.test(row[1]) &&
        /^[a-f0-9]{64}$/.test(row[2]) &&
        !seen.has(row[0] + ':' + row[1]),
      'ARCHIVE_METADATA_INVALID'
    );
    seen.add(row[0] + ':' + row[1]);
  }
  for (const kind of ['S', 'T', 'F', 'E', 'V'])
    requireValue(
      Number.isSafeInteger(snapshot.counts[kind]) &&
        snapshot.counts[kind] === snapshot.rows.filter((row) => row[0] === kind).length,
      'ARCHIVE_METADATA_INVALID'
    );
}
export function sealArchive(manifest, compressed, key) {
  if (!key)
    return {
      magic: MAGIC,
      manifest,
      encryption: 'OWNED_FIXTURE_PLAINTEXT',
      nonce: null,
      tag: null,
      payload: compressed.toString('base64')
    };
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(canonical(manifest)));
  const payload = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return {
    magic: MAGIC,
    manifest,
    encryption: 'AES-256-GCM',
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    payload: payload.toString('base64')
  };
}
export function openArchive(raw, key, fixtureOwner) {
  const archive = JSON.parse(raw);
  requireValue(
    exactKeys(archive, ['magic', 'manifest', 'encryption', 'nonce', 'tag', 'payload']) &&
      archive.magic === MAGIC &&
      exactKeys(archive.manifest, [
        'database',
        'mysqlVersion',
        'mode',
        'fixtureOwner',
        'createdAt',
        'sqlSha256',
        'gzipSha256',
        'definitions'
      ]) &&
      typeof archive.payload === 'string' &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(archive.payload),
    'ARCHIVE_FORMAT_INVALID'
  );
  const manifest = archive.manifest;
  identifier(manifest.database);
  requireValue(
    /^8\.4\.\d+$/.test(manifest.mysqlVersion) &&
      /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(manifest.createdAt) &&
      /^[a-f0-9]{64}$/.test(manifest.sqlSha256) &&
      /^[a-f0-9]{64}$/.test(manifest.gzipSha256),
    'ARCHIVE_FORMAT_INVALID'
  );
  validateSnapshot(manifest.definitions);
  let compressed;
  if (fixtureOwner) {
    requireValue(
      manifest.mode === 'OWNED_EMPTY_FIXTURE' &&
        manifest.fixtureOwner === fixtureOwner &&
        /^idv2_native_fixture_[a-f0-9]{12}$/.test(manifest.database),
      'FIXTURE_OWNER_MISMATCH'
    );
  } else {
    requireValue(
      manifest.mode === 'CURRENT_ID_CORE' &&
        manifest.fixtureOwner === null &&
        archive.encryption === 'AES-256-GCM',
      'USER_DATA_ENCRYPTION_REQUIRED'
    );
    requireCoreSnapshot(manifest.definitions);
  }
  if (archive.encryption === 'AES-256-GCM') {
    requireValue(
      Buffer.isBuffer(key) &&
        key.length === 32 &&
        typeof archive.nonce === 'string' &&
        Buffer.from(archive.nonce, 'base64').length === 12 &&
        typeof archive.tag === 'string' &&
        Buffer.from(archive.tag, 'base64').length === 16,
      'ENCRYPTION_KEY_REQUIRED'
    );
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(archive.nonce, 'base64'));
    decipher.setAAD(Buffer.from(canonical(manifest)));
    decipher.setAuthTag(Buffer.from(archive.tag, 'base64'));
    try {
      compressed = Buffer.concat([
        decipher.update(Buffer.from(archive.payload, 'base64')),
        decipher.final()
      ]);
    } catch {
      throw new NativeMysqlError('ARCHIVE_AUTHENTICATION_FAILED');
    }
  } else {
    requireValue(
      fixtureOwner &&
        archive.encryption === 'OWNED_FIXTURE_PLAINTEXT' &&
        archive.nonce === null &&
        archive.tag === null,
      'USER_DATA_ENCRYPTION_REQUIRED'
    );
    compressed = Buffer.from(archive.payload, 'base64');
  }
  requireValue(
    compressed.length <= MAX_BYTES && sha256(compressed) === manifest.gzipSha256,
    'ARCHIVE_CHECKSUM_FAILED'
  );
  let dump;
  try {
    dump = gunzipSync(compressed, { maxOutputLength: MAX_BYTES });
  } catch {
    throw new NativeMysqlError('ARCHIVE_GZIP_INVALID');
  }
  requireValue(sha256(dump) === manifest.sqlSha256, 'ARCHIVE_CHECKSUM_FAILED');
  return { manifest, dump };
}
async function backupSource(options, source, fixtureOwner = null) {
  const tools = source.tools;
  identifier(options.database);
  const directory = await projectDirectory(options.outputDirectory);
  const space = await statfs(directory);
  requireValue(space.bavail * space.bsize >= 2 * MAX_BYTES, 'INSUFFICIENT_BACKUP_SPACE');
  let key;
  const created = [];
  try {
    if (options.keyFile) key = await encryptionKey(options.keyFile);
    requireValue(fixtureOwner || key, 'USER_DATA_ENCRYPTION_REQUIRED');
    const connection = {
      ...source.connection,
      args: [...source.connection.args, '--init-command=SET SESSION TRANSACTION READ ONLY']
    };
    const identity = JSON.parse(
      await sql(
        tools,
        connection,
        options.database,
        "SELECT JSON_OBJECT('database',DATABASE(),'readOnly',@@session.transaction_read_only," +
          "'version',@@version,'unsupportedEngines',(SELECT COUNT(*) FROM information_schema.tables " +
          "WHERE table_schema=DATABASE() AND table_type='BASE TABLE' AND engine<>'InnoDB'));",
        { cap: 4096, signal: options.signal }
      )
    );
    requireValue(
      identity.database === options.database &&
        Number(identity.readOnly) === 1 &&
        /^8\.4\.\d+/.test(identity.version) &&
        Number(identity.unsupportedEngines) === 0,
      'READONLY_SOURCE_IDENTITY_INVALID'
    );
    const before = await definitionSnapshot(tools, connection, options.database, {
      signal: options.signal
    });
    if (!fixtureOwner) requireCoreSnapshot(before);
    let dump = await run(tools.mysqldump, dumpArguments(source.connection, options.database), {
      cwd: source.connection.cwd,
      timeout: 240000,
      signal: options.signal
    });
    dump = normalizeDump(dump);
    const headers = [...dump.toString().matchAll(/^-- Host: .*Database: ([A-Za-z0-9_]+)\s*$/gm)];
    requireValue(
      headers.length > 0 && headers.every((row) => row[1] === options.database),
      'DUMP_DATABASE_HEADER_INVALID'
    );
    const after = await definitionSnapshot(tools, connection, options.database, {
      signal: options.signal
    });
    requireValue(before.sha256 === after.sha256, 'SOURCE_DEFINITIONS_CHANGED');
    const compressed = gzipSync(dump, { level: 9 });
    const manifest = {
      database: options.database,
      mysqlVersion: tools.version,
      mode: fixtureOwner ? 'OWNED_EMPTY_FIXTURE' : 'CURRENT_ID_CORE',
      fixtureOwner,
      createdAt: new Date().toISOString(),
      sqlSha256: sha256(dump),
      gzipSha256: sha256(compressed),
      definitions: before
    };
    const bytes = Buffer.from(canonical(sealArchive(manifest, compressed, key)) + '\n');
    const basename =
      'id-business-v2-native-' +
      manifest.createdAt.replaceAll(/[-:.]/g, '') +
      '-' +
      randomBytes(6).toString('hex') +
      '.backup.json';
    const path = join(directory, basename);
    await exclusivePrivateWrite(path, bytes);
    created.push(path);
    requireValue(
      sha256(await privateBytes(path, 2 * MAX_BYTES)) === sha256(bytes),
      'WRITTEN_ARCHIVE_CHANGED'
    );
    const result = {
      status: 'LOCAL_BACKUP_COMPLETE',
      archive: path,
      archiveSha256: sha256(bytes),
      bytes: bytes.length,
      mysqlVersion: tools.version,
      definitionsSha256: before.sha256,
      counts: before.counts,
      sourceReadOnly: true,
      sourceMutated: false,
      encryption: key ? 'AES-256-GCM' : 'OWNED_FIXTURE_PLAINTEXT',
      fixtureOnly: Boolean(fixtureOwner),
      productionAcceptance: 'NOT_MEASURED',
      dockerUsed: false,
      awsCalled: false,
      s3: s3Preparation(options, path, bytes)
    };
    if (fixtureOwner) requireValue(!options.s3Bucket, 'FIXTURE_S3_FORBIDDEN');
    const receipt = path + '.receipt.json';
    await exclusivePrivateWrite(receipt, Buffer.from(JSON.stringify(result, null, 2) + '\n'));
    created.push(receipt);
    return result;
  } catch (error) {
    for (const path of created) await rm(path, { force: true });
    throw error;
  } finally {
    key?.fill(0);
  }
}
export async function backup(options) {
  requireValue(options.binDirectory, 'BIN_DIRECTORY_REQUIRED');
  const tools = await mysqlTools(options.binDirectory);
  const connection = await configuredConnection(options.defaultsFile);
  return backupSource(options, { tools, connection });
}
export async function backupOwnedFixture(options, instance) {
  const details = ownedInstance(instance);
  requireValue(
    /^idv2_native_fixture_[a-f0-9]{12}$/.test(options.database),
    'FIXTURE_DATABASE_INVALID'
  );
  details.fixtureOwner ??= randomBytes(16).toString('hex');
  const tables = await sql(
    details.tools,
    details.connection,
    options.database,
    'SELECT TABLE_NAME FROM information_schema.tables ' +
      "WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY TABLE_NAME;",
    { cap: 4096 }
  );
  for (const table of tables ? tables.split('\n') : [])
    requireValue(
      (await sql(
        details.tools,
        details.connection,
        options.database,
        'SELECT COUNT(*) FROM ' + identifier(table) + ';',
        { cap: 4096 }
      )) === '0',
      'FIXTURE_MUST_BE_EMPTY'
    );
  return backupSource(options, details, details.fixtureOwner);
}
async function verifyArchive(options, fixtureOwner = null) {
  requireValue(!options.defaultsFile && !options.database, 'RESTORE_TARGET_OPTIONS_FORBIDDEN');
  requireValue(options.binDirectory, 'BIN_DIRECTORY_REQUIRED');
  const tools = await mysqlTools(options.binDirectory);
  let key, instance;
  try {
    if (options.keyFile) key = await encryptionKey(options.keyFile);
    const raw = await privateBytes(options.archive, 2 * MAX_BYTES);
    const initialHash = sha256(raw);
    const { manifest, dump } = openArchive(raw, key, fixtureOwner);
    instance = await startIsolatedMysql(tools, options.workDirectory, { signal: options.signal });
    const owned = ownedInstance(instance);
    const sqlOptions = { signal: options.signal, timeout: 240000 };
    await sql(
      tools,
      owned.connection,
      null,
      'CREATE DATABASE ' +
        identifier(manifest.database) +
        ' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;',
      sqlOptions
    );
    if (!fixtureOwner)
      await sql(
        tools,
        owned.connection,
        manifest.database,
        "CREATE USER 'id_business_migrator'@'%' ACCOUNT LOCK; GRANT ALL PRIVILEGES ON " +
          identifier(manifest.database) +
          ".* TO 'id_business_migrator'@'%';",
        sqlOptions
      );
    await sql(tools, owned.connection, manifest.database, dump, sqlOptions);
    const snapshot = await definitionSnapshot(
      tools,
      owned.connection,
      manifest.database,
      sqlOptions
    );
    requireValue(snapshot.sha256 === manifest.definitions.sha256, 'RESTORED_DEFINITIONS_MISMATCH');
    await checkTables(tools, owned.connection, manifest.database, snapshot, sqlOptions);
    const protection = fixtureOwner
      ? { rollbackProbes: 'NOT_APPLICABLE_EMPTY_FIXTURE', originalDefinerLocked: 'NOT_MEASURED' }
      : await coreRestoreProtection(tools, owned.connection, manifest.database, sqlOptions);
    requireValue(
      (await definitionSnapshot(tools, owned.connection, manifest.database, sqlOptions)).sha256 ===
        snapshot.sha256,
      'RESTORED_DEFINITIONS_CHANGED'
    );
    requireValue(
      sha256(await privateBytes(options.archive, 2 * MAX_BYTES)) === initialHash,
      'ARCHIVE_CHANGED_DURING_RESTORE'
    );
    return {
      status: 'ISOLATED_RESTORE_VERIFIED',
      archiveSha256: initialHash,
      definitionsSha256: snapshot.sha256,
      counts: snapshot.counts,
      mysqlVersion: tools.version,
      privateUnixSocket: true,
      tcpDisabled: true,
      eventSchedulerDisabled: true,
      existingDatabaseConnected: false,
      cleanup: 'OWNED_INSTANCE_REMOVED_IN_FINALLY',
      fixtureOnly: Boolean(fixtureOwner),
      productionAcceptance: 'NOT_MEASURED',
      finance49: 'UNCHANGED_NOT_EXECUTED_BY_THIS_ENTRY',
      ...protection,
      dockerUsed: false,
      awsCalled: false
    };
  } finally {
    key?.fill(0);
    if (instance) await instance.cleanup();
  }
}
export const verify = (options) => verifyArchive(options);
export function verifyOwnedFixture(options, sourceInstance) {
  const details = ownedInstance(sourceInstance);
  requireValue(details.fixtureOwner, 'FIXTURE_OWNER_MISSING');
  return verifyArchive(options, details.fixtureOwner);
}
export async function fixtureSmoke(options) {
  requireValue(options.binDirectory, 'BIN_DIRECTORY_REQUIRED');
  requireValue(
    !options.defaultsFile && !options.database && !options.archive && !options.keyFile,
    'FIXTURE_SOURCE_OPTIONS_FORBIDDEN'
  );
  const work = await projectDirectory(options.workDirectory);
  const area = await mkdtemp(join(work, 'owned-smoke-'));
  let source;
  try {
    const tools = await mysqlTools(options.binDirectory);
    source = await startIsolatedMysql(tools, area, { signal: options.signal });
    const owned = ownedInstance(source);
    const database = 'idv2_native_fixture_' + randomBytes(6).toString('hex');
    await sql(
      tools,
      owned.connection,
      null,
      'CREATE DATABASE ' + database + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;'
    );
    await sql(
      tools,
      owned.connection,
      database,
      'CREATE TABLE fixture_empty(id INT PRIMARY KEY, note VARCHAR(30)) ENGINE=InnoDB;\n' +
        'CREATE FUNCTION fixture_count() RETURNS INT DETERMINISTIC NO SQL RETURN 0;\n' +
        'CREATE TRIGGER fixture_guard BEFORE INSERT ON fixture_empty FOR EACH ROW ' +
        "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Empty fixture protected';\n" +
        'CREATE EVENT fixture_event ON SCHEDULE EVERY 1 DAY DO SELECT 1;'
    );
    const fileProbe = join(source.directory, 'file-access-probe');
    let fileWriteRejected = false;
    try {
      await sql(
        tools,
        owned.connection,
        database,
        "SELECT 1 INTO OUTFILE '" + fileProbe.replaceAll("'", "''") + "';"
      );
    } catch (error) {
      fileWriteRejected = error instanceof NativeMysqlError && error.code === 'COMMAND_FAILED';
    }
    requireValue(
      fileWriteRejected && !(await lstat(fileProbe).catch(() => null)),
      'FIXTURE_FILE_ACCESS_NOT_REJECTED'
    );
    const initialInstances = (await readdir(area))
      .filter((name) => name.startsWith('owned-mysql-'))
      .sort();
    const result = await backupOwnedFixture(
      { database, outputDirectory: area, signal: options.signal },
      source
    );
    requireValue(
      result.sourceReadOnly &&
        result.fixtureOnly &&
        canonical(result.counts) === canonical({ S: 1, T: 1, F: 1, E: 1, V: 0 }),
      'FIXTURE_BACKUP_FAILED'
    );
    const restore = await verifyOwnedFixture(
      {
        binDirectory: options.binDirectory,
        workDirectory: area,
        archive: result.archive,
        signal: options.signal
      },
      source
    );
    requireValue(
      restore.tcpDisabled &&
        restore.privateUnixSocket &&
        restore.eventSchedulerDisabled &&
        !restore.existingDatabaseConnected &&
        restore.definitionsSha256 === result.definitionsSha256,
      'FIXTURE_RESTORE_FAILED'
    );
    requireValue(
      canonical((await readdir(area)).filter((name) => name.startsWith('owned-mysql-')).sort()) ===
        canonical(initialInstances),
      'FIXTURE_RESTORE_CLEANUP_FAILED'
    );
    let forbiddenRejected = false;
    try {
      await verify({
        binDirectory: options.binDirectory,
        workDirectory: area,
        archive: result.archive
      });
    } catch (error) {
      forbiddenRejected =
        error instanceof NativeMysqlError && error.code === 'USER_DATA_ENCRYPTION_REQUIRED';
    }
    requireValue(forbiddenRejected, 'FIXTURE_PLAINTEXT_CLI_BOUNDARY_FAILED');
    const broken = JSON.parse(await privateBytes(result.archive, 2 * MAX_BYTES));
    const invalidSql = Buffer.from('THIS IS INVALID SQL;\n');
    const compressed = gzipSync(invalidSql);
    broken.payload = compressed.toString('base64');
    broken.manifest.sqlSha256 = sha256(invalidSql);
    broken.manifest.gzipSha256 = sha256(compressed);
    const invalidPath = join(area, 'owned-invalid.backup.json');
    await exclusivePrivateWrite(invalidPath, Buffer.from(canonical(broken)));
    let badRestoreRejected = false;
    try {
      await verifyOwnedFixture(
        {
          binDirectory: options.binDirectory,
          workDirectory: area,
          archive: invalidPath,
          signal: options.signal
        },
        source
      );
    } catch (error) {
      badRestoreRejected = error instanceof NativeMysqlError && error.code === 'COMMAND_FAILED';
    }
    requireValue(badRestoreRejected, 'FIXTURE_BAD_RESTORE_NOT_REJECTED');
    requireValue(
      canonical((await readdir(area)).filter((name) => name.startsWith('owned-mysql-')).sort()) ===
        canonical(initialInstances),
      'FIXTURE_FAILURE_CLEANUP_FAILED'
    );
    requireValue(
      (await sql(tools, owned.connection, database, 'SELECT COUNT(*) FROM fixture_empty;')) ===
        '0' && (await sql(tools, owned.connection, database, 'SELECT fixture_count();')) === '0',
      'FIXTURE_SOURCE_CHANGED'
    );
    await sql(
      tools,
      owned.connection,
      database,
      'DROP TRIGGER fixture_guard; INSERT INTO fixture_empty VALUES(1,NULL);'
    );
    let populatedRejected = false;
    try {
      await backupOwnedFixture({ database, outputDirectory: area }, source);
    } catch (error) {
      populatedRejected =
        error instanceof NativeMysqlError && error.code === 'FIXTURE_MUST_BE_EMPTY';
    }
    requireValue(populatedRejected, 'FIXTURE_NONEMPTY_BACKUP_NOT_REJECTED');
    return {
      status: 'OWNED_EMPTY_FIXTURE_SMOKE_VERIFIED',
      mysqlVersion: tools.version,
      checks: [
        'read-only-backup',
        'routines-events-triggers-preserved',
        'private-unix-socket',
        'tcp-off',
        'event-scheduler-off',
        'file-write-rejected',
        'definition-hashes-equal',
        'check-tables',
        'plain-user-archive-rejected',
        'bad-restore-rejected',
        'failure-instance-cleaned',
        'source-unchanged',
        'nonempty-plaintext-rejected'
      ],
      dumpDefinitionCounts: result.counts,
      archiveSha256: result.archiveSha256,
      definitionsSha256: result.definitionsSha256,
      userCredentialsUsed: false,
      userDatabaseConnected: false,
      productionAcceptance: 'NOT_MEASURED',
      finance49: 'UNCHANGED_NOT_EXECUTED_BY_THIS_ENTRY',
      dockerUsed: false,
      awsCalled: false,
      ownProcessesAndTemporaryFilesRemoved: true
    };
  } finally {
    if (source) await source.cleanup();
    await rm(area, { recursive: true });
  }
}
async function main() {
  const options = parseArgs([...process.argv.slice(2)]);
  const abort = new AbortController();
  options.signal = abort.signal;
  const interrupt = () => abort.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const result = ['check', 'preflight'].includes(options.command)
      ? await preflight(options)
      : options.command === 'backup'
        ? await backup(options)
        : options.command === 'fixture-smoke'
          ? await fixtureSmoke(options)
          : await verify(options);
    console.log(JSON.stringify(result));
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.log(
      JSON.stringify({
        status: 'BLOCKED',
        code: error instanceof NativeMysqlError ? error.code : 'UNCLASSIFIED',
        rawErrorSuppressed: true,
        productionAcceptance: 'NOT_MEASURED'
      })
    );
    process.exitCode = 1;
  });
}
