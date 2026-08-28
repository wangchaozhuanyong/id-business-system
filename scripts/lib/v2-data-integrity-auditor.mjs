const AUDIT_USERNAME = 'id_business_audit';
const LOCAL_MYSQL_HOSTS = new Set(['127.0.0.1', 'localhost']);

export function buildV2AuditAccountProvisioning(environment) {
  const auditUrlText = required(environment, 'V2_DATA_INTEGRITY_DATABASE_URL');
  const mysqlDatabase = required(environment, 'MYSQL_DATABASE');
  const rootPassword = required(environment, 'MYSQL_ROOT_PASSWORD');
  const auditUrl = parseMysqlUrl(auditUrlText, 'V2_DATA_INTEGRITY_DATABASE_URL');
  const auditUsername = decodeURIComponent(auditUrl.username);
  const auditPassword = decodeURIComponent(auditUrl.password);
  const auditDatabase = decodeURIComponent(auditUrl.pathname.replace(/^\//, ''));

  if (auditUsername !== AUDIT_USERNAME) {
    throw new Error(`V2_DATA_INTEGRITY_DATABASE_URL 用户名必须为 ${AUDIT_USERNAME}`);
  }
  if (!LOCAL_MYSQL_HOSTS.has(auditUrl.hostname)) {
    throw new Error('生产完整性审计仅允许通过 EC2 本机 127.0.0.1/localhost 连接 MySQL');
  }
  if (auditDatabase !== mysqlDatabase || !/^[A-Za-z0-9_]+$/.test(mysqlDatabase)) {
    throw new Error('V2_DATA_INTEGRITY_DATABASE_URL 数据库名必须与 MYSQL_DATABASE 一致');
  }
  assertProductionSecret(auditPassword, '完整性审计账号密码');
  assertProductionSecret(rootPassword, 'MySQL root 密码');

  const rootUrl = new URL(auditUrl);
  rootUrl.username = 'root';
  rootUrl.password = rootPassword;
  rootUrl.port = environment.MYSQL_HOST_PORT?.trim() || auditUrl.port || '3306';

  const account = `'${AUDIT_USERNAME}'@'%'`;
  const database = `\`${mysqlDatabase}\``;
  const password = mysqlStringLiteral(auditPassword);
  return {
    auditUsername: AUDIT_USERNAME,
    rootDatabaseUrl: rootUrl.toString(),
    statements: [
      `CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${password}`,
      `ALTER USER ${account} IDENTIFIED BY ${password}`,
      `REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account}`,
      `GRANT SELECT, SHOW VIEW ON ${database}.* TO ${account}`,
      `GRANT EXECUTE ON FUNCTION ${database}.\`idv2_integrity_trigger_exists\` TO ${account}`
    ],
    showGrantsSql: `SHOW GRANTS FOR ${account}`
  };
}

function required(environment, key) {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`${key} 未配置`);
  return value;
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

function assertProductionSecret(value, label) {
  if (value.length < 24 || /replace[_-]?with|change[_-]?me|example|placeholder/i.test(value)) {
    throw new Error(`${label} 必须是至少 24 位的真实随机值，不能使用模板占位值`);
  }
}

function mysqlStringLiteral(value) {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error('完整性审计账号密码不能包含 NUL 或换行符');
  }
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}
