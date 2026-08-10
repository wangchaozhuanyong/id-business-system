import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { access, lstat, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const NATIVE_POSTGRES_CLIENT_VERSION = '17.10';
export const NATIVE_POSTGRES_COMMANDS = Object.freeze(['pg_dump', 'pg_restore', 'psql']);

const PINNED_FILE_SHA256 = Object.freeze({
  'bin/pg_dump': 'fcf942438ee1844a0ccc029bbce18d69bc94166fa3f9053e3611e65285478209',
  'bin/pg_restore': '5265c50c6e28c9888d0fa23fbcf0dd2e45e6485a6b7846a0d11347cc2eaa6e30',
  'bin/psql': 'e18000996705007127b49872d46551558c98e80a8d0f2b26a67f9128c54689bd',
  'lib/libpq.5.dylib': '97b4182ade0fa9ded42256ef476d97756c8ef0ef1953311cfac29e263cbe9676',
  'lib/libssl.3.dylib': '352d34605c712f101490cd8d9ba6f62ec6cba916e0eaced0ad88648e0ad24267',
  'lib/libcrypto.3.dylib': '4c0686b2a0d01530bddeef76da77e72edeb10ccb236ef9ae3740c600af87e609',
  'lib/libzstd.1.5.7.dylib': '02df30fa5749b4dedf1fe77f0cb42e97b7f16bc5b95dd3fc4ff4cf5f38c8a5b8',
  'lib/liblz4.1.10.0.dylib': 'c73448d4f0d9761ba242a1d337cba718b7091c555c0ce54ee3303abda8bf3da7'
});

const PINNED_SYMLINKS = Object.freeze({
  'lib/libzstd.1.dylib': 'libzstd.1.5.7.dylib',
  'lib/liblz4.1.dylib': 'liblz4.1.10.0.dylib'
});

export function defaultNativePostgresBinDirectory() {
  return path.join(
    homedir(),
    '.local',
    'share',
    'id-business-v2',
    `postgresql-${NATIVE_POSTGRES_CLIENT_VERSION}`,
    'bin'
  );
}

export async function resolveNativePostgresClient(inputDirectory) {
  const expectedDirectory = path.resolve(
    inputDirectory || process.env.POSTGRES_BACKUP_BIN_DIR || defaultNativePostgresBinDirectory()
  );
  const directory = await realpath(expectedDirectory);
  if (directory !== expectedDirectory)
    throw new Error('原生 PostgreSQL 客户端目录不得经过符号链接');
  if (directory === path.resolve(defaultNativePostgresBinDirectory())) {
    await verifyPinnedClientIntegrity(path.dirname(directory));
  }

  const commands = {};
  let version;
  for (const command of NATIVE_POSTGRES_COMMANDS) {
    const commandPath = path.join(directory, command);
    const metadata = await lstat(commandPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`原生 PostgreSQL 命令不是普通文件：${command}`);
    }
    await access(commandPath, fsConstants.X_OK);
    const commandVersion = await readPostgresCommandVersion(commandPath);
    if (!commandVersion.startsWith('17.')) {
      throw new Error(`原生 PostgreSQL 命令主版本不是17：${command}`);
    }
    if (version && commandVersion !== version) throw new Error('原生 PostgreSQL 命令版本不一致');
    version = commandVersion;
    commands[command] = commandPath;
  }
  return { directory, version, commands };
}

async function verifyPinnedClientIntegrity(clientRoot) {
  for (const [relativePath, expectedSha256] of Object.entries(PINNED_FILE_SHA256)) {
    const filePath = path.join(clientRoot, relativePath);
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`原生 PostgreSQL 固定文件类型无效：${relativePath}`);
    }
    const actualSha256 = await sha256File(filePath);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`原生 PostgreSQL 固定文件校验失败：${relativePath}`);
    }
  }
  for (const [relativePath, expectedTarget] of Object.entries(PINNED_SYMLINKS)) {
    const linkPath = path.join(clientRoot, relativePath);
    const metadata = await lstat(linkPath);
    if (!metadata.isSymbolicLink() || (await readlink(linkPath)) !== expectedTarget) {
      throw new Error(`原生 PostgreSQL 动态库链接校验失败：${relativePath}`);
    }
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function readPostgresCommandVersion(commandPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout = boundedAppend(stdout, chunk, 4096)));
    child.stderr.on('data', (chunk) => (stderr = boundedAppend(stderr, chunk, 4096)));
    const timer = setTimeout(() => child.kill('SIGTERM'), 5_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal) {
        reject(new Error(`无法读取原生 PostgreSQL 命令版本：${stderr.trim().slice(-300)}`));
        return;
      }
      const match = stdout.match(/\(PostgreSQL\) ([0-9]+\.[0-9]+)/u);
      if (!match) reject(new Error('原生 PostgreSQL 命令版本格式无效'));
      else resolve(match[1]);
    });
  });
}

function boundedAppend(current, chunk, maximumLength) {
  const combined = current + String(chunk);
  return combined.length <= maximumLength ? combined : combined.slice(-maximumLength);
}
