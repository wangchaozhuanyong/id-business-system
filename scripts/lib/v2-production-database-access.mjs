const MIGRATION_USERNAME = 'id_business_migrator';
const RUNTIME_USERNAME = 'id_business_app';
const AUDIT_USERNAME = 'id_business_audit';
const BACKUP_USERNAME = 'id_business_backup';
const LOCAL_MYSQL_HOSTS = new Set(['127.0.0.1', 'localhost']);

export const V2_RUNTIME_DELETE_TABLES = Object.freeze([
  'id_business_v2_exchange_rate_provider_snapshots',
  'id_business_v2_exchange_rate_quote_samples',
  'id_business_v2_exchange_rate_runs',
  'id_business_v2_exchange_rate_snapshots',
  'id_business_v2_finance_fx_rate_snapshots',
  'id_business_v2_sensitive_display_policies',
  'id_business_v2_user_table_preferences',
  'id_business_v2_website_visits',
  'id_business_v2_workspace_shortcuts',
  'ip_whitelists',
  'role_permissions',
  'user_roles'
]);

const RUNTIME_UPDATE_DENIED_TABLES = new Set([
  '_prisma_migrations',
  'audit_logs',
  'sensitive_access_logs'
]);
const RUNTIME_DELETE_TABLE_SET = new Set(V2_RUNTIME_DELETE_TABLES);

export function buildV2ProductionDatabaseAccountProvisioning(environment) {
  const databaseName = required(environment, 'MYSQL_DATABASE');
  if (!/^[A-Za-z0-9_]+$/.test(databaseName)) {
    throw new Error('MYSQL_DATABASE 只能包含字母、数字和下划线');
  }

  const rootPassword = required(environment, 'MYSQL_ROOT_PASSWORD');
  const migrationUsername = required(environment, 'MYSQL_USER');
  const migrationPassword = required(environment, 'MYSQL_PASSWORD');
  const backupUsername = required(environment, 'MYSQL_BACKUP_USER');
  const backupPassword = required(environment, 'MYSQL_BACKUP_PASSWORD');
  const migrationUrl = parseMysqlUrl(
    required(environment, 'MIGRATION_DATABASE_URL'),
    'MIGRATION_DATABASE_URL'
  );
  const runtimeUrl = parseMysqlUrl(required(environment, 'DATABASE_URL'), 'DATABASE_URL');
  const localRuntimeUrl = parseMysqlUrl(
    required(environment, 'V2_RUNTIME_DATABASE_URL'),
    'V2_RUNTIME_DATABASE_URL'
  );
  const auditUrl = parseMysqlUrl(
    required(environment, 'V2_DATA_INTEGRITY_DATABASE_URL'),
    'V2_DATA_INTEGRITY_DATABASE_URL'
  );

  assertAccount(migrationUrl, MIGRATION_USERNAME, databaseName, 'MIGRATION_DATABASE_URL');
  assertAccount(runtimeUrl, RUNTIME_USERNAME, databaseName, 'DATABASE_URL');
  assertAccount(localRuntimeUrl, RUNTIME_USERNAME, databaseName, 'V2_RUNTIME_DATABASE_URL');
  assertAccount(auditUrl, AUDIT_USERNAME, databaseName, 'V2_DATA_INTEGRITY_DATABASE_URL');
  if (migrationUsername !== MIGRATION_USERNAME) {
    throw new Error(`MYSQL_USER 必须为 ${MIGRATION_USERNAME}`);
  }
  if (backupUsername !== BACKUP_USERNAME) {
    throw new Error(`MYSQL_BACKUP_USER 必须为 ${BACKUP_USERNAME}`);
  }
  if (migrationUrl.hostname !== 'mysql' || runtimeUrl.hostname !== 'mysql') {
    throw new Error('MIGRATION_DATABASE_URL 和 DATABASE_URL 必须连接 Compose mysql 服务');
  }
  if (
    !LOCAL_MYSQL_HOSTS.has(localRuntimeUrl.hostname) ||
    !LOCAL_MYSQL_HOSTS.has(auditUrl.hostname)
  ) {
    throw new Error('运行权限门禁和完整性审计只能通过 EC2 本机连接 MySQL');
  }

  const decodedMigrationPassword = decodeURIComponent(migrationUrl.password);
  const decodedRuntimePassword = decodeURIComponent(runtimeUrl.password);
  const decodedLocalRuntimePassword = decodeURIComponent(localRuntimeUrl.password);
  const decodedAuditPassword = decodeURIComponent(auditUrl.password);
  if (decodedMigrationPassword !== migrationPassword) {
    throw new Error('MIGRATION_DATABASE_URL 密码必须与 MYSQL_PASSWORD 一致');
  }
  if (decodedRuntimePassword !== decodedLocalRuntimePassword) {
    throw new Error('DATABASE_URL 与 V2_RUNTIME_DATABASE_URL 必须使用相同运行账号密码');
  }
  for (const [value, label] of [
    [rootPassword, 'MySQL root 密码'],
    [migrationPassword, '迁移账号密码'],
    [decodedRuntimePassword, '运行账号密码'],
    [decodedAuditPassword, '完整性审计账号密码'],
    [backupPassword, '备份账号密码']
  ]) {
    assertProductionSecret(value, label);
  }
  if (
    new Set([
      rootPassword,
      migrationPassword,
      decodedRuntimePassword,
      decodedAuditPassword,
      backupPassword
    ]).size !== 5
  ) {
    throw new Error('root、迁移、运行、审计和备份账号必须使用不同密码');
  }

  const localBaseUrl = new URL(localRuntimeUrl);
  localBaseUrl.port = environment.MYSQL_HOST_PORT?.trim() || localRuntimeUrl.port || '3306';
  const rootDatabaseUrl = withCredentials(localBaseUrl, 'root', rootPassword);
  const localMigrationDatabaseUrl = withCredentials(
    localBaseUrl,
    MIGRATION_USERNAME,
    migrationPassword
  );
  const localBackupDatabaseUrl = withCredentials(localBaseUrl, BACKUP_USERNAME, backupPassword);
  const database = quoteIdentifier(databaseName);
  const migrationAccount = quoteAccount(MIGRATION_USERNAME);
  const runtimeAccount = quoteAccount(RUNTIME_USERNAME);
  const backupAccount = quoteAccount(BACKUP_USERNAME);

  return {
    accounts: {
      audit: AUDIT_USERNAME,
      backup: BACKUP_USERNAME,
      migration: MIGRATION_USERNAME,
      runtime: RUNTIME_USERNAME
    },
    databaseName,
    localAuditDatabaseUrl: auditUrl.toString(),
    localBackupDatabaseUrl,
    localMigrationDatabaseUrl,
    localRuntimeDatabaseUrl: localRuntimeUrl.toString(),
    rootDatabaseUrl,
    statements: [
      ...accountResetStatements(migrationAccount, migrationPassword),
      ...accountResetStatements(runtimeAccount, decodedRuntimePassword),
      ...accountResetStatements(backupAccount, backupPassword),
      `GRANT ALL PRIVILEGES ON ${database}.* TO ${migrationAccount}`,
      `GRANT SELECT, SHOW VIEW, TRIGGER ON ${database}.* TO ${backupAccount}`
    ],
    showGrantsSql: {
      backup: `SHOW GRANTS FOR ${backupAccount}`,
      migration: `SHOW GRANTS FOR ${migrationAccount}`,
      runtime: `SHOW GRANTS FOR ${runtimeAccount}`
    }
  };
}

export function buildV2RuntimeTableGrantStatements(databaseName, tableNames) {
  if (!/^[A-Za-z0-9_]+$/.test(databaseName)) throw new Error('数据库名格式无效');
  const runtimeAccount = quoteAccount(RUNTIME_USERNAME);
  const database = quoteIdentifier(databaseName);
  const uniqueTableNames = [...new Set(tableNames)].sort();
  return uniqueTableNames.map((tableName) => {
    if (!/^[A-Za-z0-9_]+$/.test(tableName)) throw new Error(`数据表名格式无效：${tableName}`);
    const privileges = ['SELECT'];
    if (tableName !== '_prisma_migrations') privileges.push('INSERT');
    if (!RUNTIME_UPDATE_DENIED_TABLES.has(tableName)) privileges.push('UPDATE');
    if (RUNTIME_DELETE_TABLE_SET.has(tableName)) privileges.push('DELETE');
    return `GRANT ${privileges.join(', ')} ON ${database}.${quoteIdentifier(tableName)} TO ${runtimeAccount}`;
  });
}

export function assertV2ProductionDatabaseGrants(input) {
  assertMigrationGrants(input.migrationGrants, input.databaseName);
  assertBackupGrants(input.backupGrants, input.databaseName);
  assertRuntimeGrants(input.runtimeGrants, input.databaseName, input.tableNames);
}

export function assertV2IntegrityFunctionDefiner(rows) {
  const routine = rows.length === 1 ? rows[0] : null;
  if (
    !routine ||
    String(routine.definer ?? '') !== `${MIGRATION_USERNAME}@%` ||
    String(routine.securityType ?? '').toUpperCase() !== 'DEFINER'
  ) {
    throw new Error(`完整性巡检函数必须由 ${MIGRATION_USERNAME}@% 以 DEFINER 模式执行`);
  }
}

export function assertV2TriggerDefiners(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('生产数据库必须存在完整性触发器');
  }

  const invalidTriggers = rows.filter(
    (row) => String(row.definer ?? '') !== `${MIGRATION_USERNAME}@%`
  );
  if (invalidTriggers.length > 0) {
    const names = invalidTriggers
      .map((row) => String(row.triggerName ?? 'unknown'))
      .sort()
      .join(', ');
    throw new Error(`完整性触发器必须由 ${MIGRATION_USERNAME}@% 持有：${names}`);
  }
}

function assertMigrationGrants(rows, databaseName) {
  const grants = grantTexts(rows).filter((grant) => !isUsageGrant(grant));
  const parsed = grants.length === 1 ? parseDatabaseGrant(grants[0]) : null;
  if (
    !parsed ||
    parsed.databaseName !== databaseName ||
    parsed.tableName !== '*' ||
    !sameSet(parsed.privileges, ['ALL PRIVILEGES']) ||
    /WITH GRANT OPTION/i.test(grants[0])
  ) {
    throw new Error('迁移账号必须仅具备当前数据库 ALL PRIVILEGES，且不得拥有 GRANT OPTION');
  }
}

function assertBackupGrants(rows, databaseName) {
  const grants = grantTexts(rows).filter((grant) => !isUsageGrant(grant));
  if (grants.length !== 1 || /WITH GRANT OPTION/i.test(grants[0])) {
    throw new Error('备份账号授权范围无效');
  }
  const parsed = parseDatabaseGrant(grants[0]);
  if (
    !parsed ||
    parsed.databaseName !== databaseName ||
    parsed.tableName !== '*' ||
    !sameSet(parsed.privileges, ['SELECT', 'SHOW VIEW', 'TRIGGER'])
  ) {
    throw new Error('备份账号必须仅具备 SELECT、SHOW VIEW 和 TRIGGER');
  }
}

function assertRuntimeGrants(rows, databaseName, tableNames) {
  const expected = new Map();
  for (const statement of buildV2RuntimeTableGrantStatements(databaseName, tableNames)) {
    const parsed = parseDatabaseGrant(statement);
    expected.set(parsed.tableName, parsed.privileges);
  }

  const actual = new Map();
  for (const grant of grantTexts(rows)) {
    if (isUsageGrant(grant)) continue;
    if (/WITH GRANT OPTION/i.test(grant)) throw new Error('运行账号不得拥有 GRANT OPTION');
    const parsed = parseDatabaseGrant(grant);
    if (!parsed || parsed.databaseName !== databaseName || parsed.tableName === '*') {
      throw new Error(`运行账号存在非表级授权：${grant}`);
    }
    if (actual.has(parsed.tableName))
      throw new Error(`运行账号数据表授权重复：${parsed.tableName}`);
    actual.set(parsed.tableName, parsed.privileges);
  }

  if (actual.size !== expected.size) {
    throw new Error(`运行账号授权表数量不匹配：${actual.size}/${expected.size}`);
  }
  for (const [tableName, privileges] of expected) {
    if (!sameSet(actual.get(tableName) ?? [], privileges)) {
      throw new Error(`运行账号数据表权限不匹配：${tableName}`);
    }
  }
}

function parseDatabaseGrant(grant) {
  const matched = grant.match(/^GRANT (.+) ON [`"]([^`"]+)[`"]\.(\*|[`"]([^`"]+)[`"]) TO /i);
  if (!matched) return null;
  return {
    databaseName: matched[2],
    privileges: matched[1].split(',').map((privilege) => privilege.trim().toUpperCase()),
    tableName: matched[3] === '*' ? '*' : matched[4]
  };
}

function grantTexts(rows) {
  return rows.map((row) => String(Object.values(row)[0] ?? '').trim());
}

function isUsageGrant(grant) {
  return /^GRANT USAGE ON \*\.\* TO /i.test(grant);
}

function accountResetStatements(account, password) {
  const literal = mysqlStringLiteral(password);
  return [
    `CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${literal}`,
    `ALTER USER ${account} IDENTIFIED BY ${literal}`,
    `REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account}`
  ];
}

function assertAccount(url, username, databaseName, label) {
  if (decodeURIComponent(url.username) !== username) {
    throw new Error(`${label} 用户名必须为 ${username}`);
  }
  if (decodeURIComponent(url.pathname.replace(/^\//, '')) !== databaseName) {
    throw new Error(`${label} 数据库名必须与 MYSQL_DATABASE 一致`);
  }
}

function parseMysqlUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} 不是有效 URL`);
  }
  if (parsed.protocol !== 'mysql:') throw new Error(`${label} 必须使用 mysql://`);
  if (!parsed.username || !parsed.password || !parsed.pathname.replace(/^\//, '')) {
    throw new Error(`${label} 必须包含用户名、密码和数据库名`);
  }
  return parsed;
}

function withCredentials(baseUrl, username, password) {
  const url = new URL(baseUrl);
  url.username = username;
  url.password = password;
  return url.toString();
}

function required(environment, key) {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`${key} 未配置`);
  return value;
}

function assertProductionSecret(value, label) {
  if (value.length < 24 || /replace[_-]?with|change[_-]?me|example|placeholder/i.test(value)) {
    throw new Error(`${label} 必须是至少 24 位的真实随机值，不能使用模板占位值`);
  }
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`${label} 不能包含 NUL 或换行符`);
  }
}

function quoteAccount(username) {
  return `'${username}'@'%'`;
}

function quoteIdentifier(value) {
  return `\`${value}\``;
}

function mysqlStringLiteral(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}
