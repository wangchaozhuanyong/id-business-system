import { parseArgs } from 'node:util';

import { BackupError, createSnapshot, restoreSnapshot, verifySnapshot } from './local-sqlite.mjs';

const usage = `用法
  node server/backup/cli.mjs snapshot --source <SQLite文件> --output <新快照目录>
  node server/backup/cli.mjs verify --input <快照目录>
  node server/backup/cli.mjs restore --input <快照目录> --key <单独保管的密钥文件> --output <新恢复目录>
  node server/backup/cli.mjs rehearse --input <快照目录> --key <单独保管的密钥文件> --output <新恢复目录>
`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: 'string' },
      input: { type: 'string' },
      output: { type: 'string' },
      key: { type: 'string' },
      help: { type: 'boolean' }
    }
  });
  const [command] = positionals;
  const commands = {
    snapshot: { options: ['source', 'output'], run: createSnapshot },
    verify: { options: ['input'], run: ({ input }) => verifySnapshot(input) },
    restore: { options: ['input', 'key', 'output'], run: restoreSnapshot },
    rehearse: { options: ['input', 'key', 'output'], run: values => restoreSnapshot({ ...values, exercise: true }) }
  };
  if (values.help && !positionals.length && Object.keys(values).length === 1) {
    process.stdout.write(usage);
  } else {
    const selected = Object.hasOwn(commands, command) ? commands[command] : null;
    const keys = Object.keys(values);
    if (!selected || positionals.length !== 1 || keys.length !== selected.options.length ||
        !selected.options.every((key) => values[key])) throw new BackupError('命令或参数无效，使用 --help 查看用法');
    process.stdout.write(JSON.stringify(await selected.run(values), null, 2) + '\n');
  }
} catch (error) {
  const message = error instanceof BackupError ? error.message : '操作失败，请核对参数、路径及文件权限';
  process.stderr.write(message + '\n');
  process.exitCode = 1;
}
