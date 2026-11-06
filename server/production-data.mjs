import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export async function productionDataPaths(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory))
    throw new Error('正式数据目录必须指定绝对路径。');
  const root = resolve(directory);
  const status = await lstat(root).catch(() => null);
  if (!status?.isDirectory() || (status.mode & 0o777) !== 0o700 ||
      status.uid !== process.getuid() || await realpath(root) !== root)
    throw new Error('正式数据目录必须由服务账号持有，权限为 0700，且不能使用软链接。');
  const databasePath = join(root, 'local-business.sqlite');
  const authPath = join(root, 'local-auth.json');
  const keyPath = databasePath + '.key';
  const paths = [databasePath, keyPath, authPath];
  const states = await Promise.all(paths.map((path) => lstat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  })));
  if (states.some((file) => file && (!file.isFile() || file.nlink !== 1 ||
      file.uid !== status.uid || (file.mode & 0o777) !== 0o600)))
    throw new Error('正式数据文件必须由服务账号持有，权限为 0600，且不能使用链接。');
  if (states[0] && !states[1]) throw new Error('正式业务库缺少原加密密钥。');
  return { databasePath, authPath, relayPath: join(root, 'local-apple-relay.json') };
}
