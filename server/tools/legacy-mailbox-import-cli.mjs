import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { createLocalBusinessStore } from '../local-business.mjs';
import { decodeLegacyMailboxPool } from './legacy-mailbox-import.mjs';
import { MailboxPoolError } from './mailbox-pool.mjs';
import { readToolConfig } from './read-tool-config.mjs';

try {
  const { values } = parseArgs({ options: {
    input: { type: 'string' },
    'legacy-key-file': { type: 'string' },
    database: { type: 'string' },
    'expected-version': { type: 'string' },
    apply: { type: 'boolean' }
  } });
  if (!values.input || !values['legacy-key-file'])
    throw new MailboxPoolError(400, '请指定加密导出文件和原系统密钥文件');
  const [bundle, keys] = await Promise.all([
    readToolConfig(values.input, 'legacy-mailbox-export'),
    readToolConfig(values['legacy-key-file'], 'legacy-mailbox-key')
  ]);
  if (!values.apply) {
    const { items } = decodeLegacyMailboxPool(bundle, keys);
    console.log(JSON.stringify({ mode: 'validate', rows: items.length }));
  } else {
    const version = Number(values['expected-version']);
    if (!values.database || !/^\d+$/.test(values['expected-version'] || '') || !Number.isSafeInteger(version))
      throw new MailboxPoolError(400, '写入需指定现有目标数据库和核对过的邮箱池版本');
    const database = resolve(values.database);
    if (!(await lstat(database)).isFile() || await realpath(database) !== database)
      throw new MailboxPoolError(400, '目标必须是现有独立版数据库文件');
    const probe = new DatabaseSync(database, { readOnly: true });
    try {
      const { count } = probe.prepare(
        "SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name IN ('business_document','business_audit')"
      ).get();
      if (count !== 2) throw new MailboxPoolError(400, '目标不是已初始化的独立版业务数据库');
    } finally {
      probe.close();
    }
    const store = createLocalBusinessStore(database);
    try {
      console.log(JSON.stringify({ mode: 'apply', ...store.importLegacyManagedMailboxPool(bundle, keys, version) }));
    } finally {
      store.close();
    }
  }
} catch (error) {
  console.error(error instanceof MailboxPoolError || error?.code?.startsWith('CONFIG_')
    ? error.message : '旧邮箱池校验或导入失败，请核对输入参数和目标数据库');
  process.exitCode = 1;
}
