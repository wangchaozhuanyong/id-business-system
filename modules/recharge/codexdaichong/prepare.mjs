import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sourceRoot = resolve(projectRoot, '.upstream/codexdaichong');
const runtimeRoot = resolve(projectRoot, '.runtime');

export const CODEXDAICHONG_REVISION = 'f4d7761e0036892e6dd68ec64c5447b513ca37da';
export const PRODUCTION_GUARD_REVISION = '2';

function isDescendant(base, target) {
  const path = relative(base, target);
  return path !== '' && path !== '..' && !path.startsWith('../') && !isAbsolute(path);
}

async function extractPinnedSource(directory) {
  // tar may exit after its end marker before git's trailing padding drains into
  // stdin. A completed archive file makes extraction independent of pipe timing.
  const temporary = await mkdtemp(resolve(runtimeRoot, 'pinned-source-'));
  const archive = resolve(temporary, 'source.tar');
  try {
    await exec('git', ['-C', sourceRoot, 'archive', '--format=tar', '--output', archive, CODEXDAICHONG_REVISION]);
    await exec('tar', ['-xf', archive, '-C', directory]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Check every tracked upstream file, including the scheduler, store and dependency lock. */
export async function verifyCodexdaichongSource(directory) {
  const destination = await realpath(directory);
  const { stdout } = await exec('git', ['-C', sourceRoot, 'ls-tree', '-rz', CODEXDAICHONG_REVISION], {
    maxBuffer: 8 * 1024 * 1024
  });
  let files = 0;
  for (const entry of stdout.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\t');
    const [mode, type, expected] = entry.slice(0, separator).split(' ');
    const name = entry.slice(separator + 1);
    if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode))
      throw new Error('锁定仓库包含不支持的文件类型');
    const path = resolve(destination, name);
    if (!isDescendant(destination, path)) throw new Error('锁定仓库路径无效');
    const stat = await lstat(path).catch(() => null);
    if (!stat || (mode === '120000' ? !stat.isSymbolicLink() : !stat.isFile() || stat.isSymbolicLink()))
      throw new Error('原版充值文件缺失或类型改变：' + name);
    if (mode !== '120000' && !isDescendant(destination, await realpath(path)))
      throw new Error('原版充值文件不能指向运行目录外');
    if (mode !== '120000' && Boolean(stat.mode & 0o111) !== (mode === '100755'))
      throw new Error('原版充值文件权限改变：' + name);
    const content = mode === '120000' ? Buffer.from(await readlink(path)) : await readFile(path);
    const actual = createHash('sha1').update('blob ' + content.length + '\0').update(content).digest('hex');
    if (actual !== expected) throw new Error('原版充值文件被改写：' + name);
    files++;
  }
  if (!files) throw new Error('锁定充值仓库没有可核验的源码');
  return { revision: CODEXDAICHONG_REVISION, files };
}

export async function prepareCodexdaichong(outputDir = resolve(runtimeRoot, 'codexdaichong')) {
  const destination = resolve(outputDir);
  if (!isDescendant(runtimeRoot, destination)) {
    throw new Error('运行副本须放在本项目的 .runtime 下');
  }
  const { stdout } = await exec('git', [
    '-C',
    sourceRoot,
    'rev-parse',
    CODEXDAICHONG_REVISION + '^{commit}'
  ]);
  if (stdout.trim() !== CODEXDAICHONG_REVISION) {
    throw new Error('未找到锁定的线上代充源码');
  }

  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const realRuntimeRoot = await realpath(runtimeRoot);
  const realProjectRoot = await realpath(projectRoot);
  if (realRuntimeRoot !== resolve(realProjectRoot, '.runtime')) {
    throw new Error('运行副本目录不能是符号链接');
  }
  const parent = await realpath(dirname(destination));
  if (parent !== realRuntimeRoot && !isDescendant(realRuntimeRoot, parent)) {
    throw new Error('运行副本的父目录不在本项目 .runtime 下');
  }
  await mkdir(destination, { mode: 0o700 });
  await extractPinnedSource(destination);

  await verifyCodexdaichongSource(destination);
  await writeFile(
    resolve(destination, '.id-business-integrated-runtime'),
    CODEXDAICHONG_REVISION + '\n',
    { flag: 'wx' }
  );
  await writeFile(resolve(destination, '.id-business-production-guard'), PRODUCTION_GUARD_REVISION + '\n', { flag: 'wx' });
  return destination;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const directory = await prepareCodexdaichong(process.argv[2]);
    console.log('线上代充隔离运行副本已准备：' + directory);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
