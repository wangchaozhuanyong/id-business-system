import { spawn } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { BackupError, UUID } from './backup-types';
import { MysqlNativeBackupSource, type MysqlBackupLauncher } from './backup-mysql-native';

export async function loadMysqlBackupCaptureConfig(config: ConfigService, sourceId: string) {
  const database = config.get<string>('GOOGLE_BACKUP_MYSQL_DATABASE')?.trim() ?? '';
  const serverUuid = config.get<string>('GOOGLE_BACKUP_MYSQL_SERVER_UUID')?.trim() ?? '';
  const options = config.get<string>('GOOGLE_BACKUP_MYSQL_OPTIONS_FILE')?.trim() ?? '';
  const publicKey = config.get<string>('GOOGLE_BACKUP_RECIPIENT_PUBLIC_KEY_FILE')?.trim() ?? '';
  if (
    !/^[a-z][a-z0-9_]{0,63}$/.test(database) ||
    !UUID.test(serverUuid) ||
    !isAbsolute(options) ||
    !isAbsolute(publicKey)
  )
    throw new BackupError('BACKUP_MYSQL_CAPTURE_CONFIG_INVALID');
  const [optionInfo, keyInfo] = await Promise.all([lstat(options), lstat(publicKey)]).catch(() => {
    throw new BackupError('BACKUP_MYSQL_CAPTURE_FILES_UNAVAILABLE');
  });
  if (
    !optionInfo.isFile() ||
    optionInfo.size > 16_384 ||
    optionInfo.mode & 0o077 ||
    !keyInfo.isFile() ||
    keyInfo.size > 16_384 ||
    keyInfo.mode & 0o022
  )
    throw new BackupError('BACKUP_MYSQL_CAPTURE_FILES_INVALID');
  const optionsText = await readFile(options, 'utf8');
  const [group, ...values] = optionsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith(';'));
  // Both clients must read the same endpoint and ignore global and personal login files.
  if (
    group !== '[client]' ||
    values.length === 0 ||
    values.some(
      (line) =>
        line.includes(String.fromCharCode(0)) ||
        !/^(?:host|port|user|password|socket|protocol|ssl-mode|ssl-ca)\s*=.+$/.test(line)
    )
  )
    throw new BackupError('BACKUP_MYSQL_CLIENT_OPTIONS_INVALID');
  const pem = await readFile(publicKey, 'utf8');
  // A private key must never be provisioned to the worker.
  if (!/^-----BEGIN (?:RSA )?PUBLIC KEY-----[\s\S]+-----END (?:RSA )?PUBLIC KEY-----\s*$/.test(pem))
    throw new BackupError('BACKUP_PUBLIC_KEY_REQUIRED');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072)
    throw new BackupError('BACKUP_PUBLIC_KEY_REQUIRED');
  const launch: MysqlBackupLauncher = (tool, args) =>
    spawn(
      tool,
      [
        tool === 'mysqlbinlog' ? '--no-defaults' : `--defaults-file=${options}`,
        '--no-login-paths',
        ...args
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }
      }
    );
  return { source: new MysqlNativeBackupSource(launch), database, serverUuid, sourceId, key };
}
