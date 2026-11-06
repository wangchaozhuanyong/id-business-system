import { parseArgs } from 'node:util';

import { migrationDemo } from './migration-demo.mjs';
import { adaptFinanceMigrationInput } from './migration-input.mjs';

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks));
  } catch {
    throw new Error('请提供有效 JSON 迁移输入，或使用 --demo');
  }
}

try {
  const { values } = parseArgs({ options: { demo: { type: 'boolean' } } });
  const input = values.demo ? migrationDemo() : await readInput();
  process.stdout.write(JSON.stringify(adaptFinanceMigrationInput(input), null, 2) + '\n');
} catch (error) {
  process.stderr.write(`财务输入适配失败：${error.message}\n`);
  process.exitCode = 1;
}
