import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);

export function resolveViteCli() {
  const packageFile = require.resolve('vite/package.json');
  const { bin } = JSON.parse(readFileSync(packageFile, 'utf8'));
  const executable = typeof bin === 'string' ? bin : bin?.vite;
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new Error('已安装 Vite 未声明 CLI 入口');
  }
  return resolve(dirname(packageFile), executable);
}
