import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const ops = join(project, 'deploy/recharge-core');

test('scheduled backup commits only a verified versioned S3 copy and safely retries the same encrypted batch', (t) => {
  const base = join(project, 'backups');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const fixture = mkdtempSync(join(base, '.scheduled-recharge-test-'));
  chmodSync(fixture, 0o700);
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const result = spawnSync('python3', ['-c', String.raw`
from pathlib import Path
import base64, importlib.util, json, os, subprocess, sys
from unittest.mock import patch

sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location('scheduled_backup', Path(sys.argv[1]) / 'scheduled-backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
os.umask(0o077)
pending = Path(sys.argv[2])
private_key = pending / 'synthetic-test-private.pem'
private_key.write_bytes(subprocess.run(
    ['openssl', 'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072'],
    check=True, capture_output=True).stdout)
public_key = pending / 'synthetic-test-public.pem'
public_key.write_bytes(subprocess.run(
    ['openssl', 'pkey', '-in', str(private_key), '-pubout'], check=True, capture_output=True).stdout)
target = {'account':'000000000000','role':'fixture-role',
          'bucket':'id-business-v2-backups-000000000000-ap-northeast-1','region':'ap-northeast-1',
          'recipientSha256':backup.file_digest(public_key)}
key, wrapped_key = backup.wrap_backup_key(public_key, target['recipientSha256'])
unwrapped = subprocess.run(
    ['openssl','pkeyutl','-decrypt','-inkey',str(private_key),'-pkeyopt','rsa_padding_mode:oaep',
     '-pkeyopt','rsa_oaep_md:sha256','-pkeyopt','rsa_mgf1_md:sha256'],
    input=base64.b64decode(wrapped_key['ciphertext']), check=True, capture_output=True).stdout
assert unwrapped == key.encode('ascii')
assert key not in json.dumps(wrapped_key)
blob = pending / backup.BACKUP_FILENAME
blob.write_bytes(b'synthetic ciphertext fixture' * 4)
manifest = pending / backup.MANIFEST
manifest.write_text(json.dumps({
    'capturedAt':'20261111T000000Z','revision':'a'*40,
    'database':backup.MYSQL_DATABASE,'wrappedKey':wrapped_key,
    'encrypted':True,'verified':True,'cipherSha256':backup.file_digest(blob),
}))
stored, operations = {}, []
bad_checksum = True

def fake_aws(target, service, action, *args):
    key = args[args.index('--key')+1]
    assert key.startswith('mysql/daily/independent-recharge/20261111T000000Z/')
    assert args[args.index('--expected-bucket-owner')+1] == target['account']
    operations.append((action, key.rsplit('/', 1)[1]))
    if action == 'put-object':
        assert args[args.index('--if-none-match')+1] == '*'
        assert args[args.index('--server-side-encryption')+1] == 'AES256'
        if key not in stored:
            path = Path(args[args.index('--body')+1])
            stored[key] = {'ChecksumSHA256':args[args.index('--checksum-sha256')+1],
                           'ContentLength':path.stat().st_size,'ServerSideEncryption':'AES256',
                           'VersionId':str(len(stored)+1)}
        raise backup.BackupError('synthetic response loss or conditional conflict')
    assert action == 'head-object' and args[args.index('--checksum-mode')+1] == 'ENABLED'
    data = stored[key].copy()
    if bad_checksum is True or bad_checksum == key.rsplit('/', 1)[1]:
        data['ChecksumSHA256'] = 'wrong'
    return data

backup.aws_json = fake_aws
try:
    backup.publish(target, pending)
except backup.BackupError as error:
    assert 'checksum' in str(error)
else:
    raise AssertionError('mismatched remote copy was accepted')
assert operations == [('put-object', backup.BACKUP_FILENAME), ('head-object', backup.BACKUP_FILENAME)]
assert manifest.is_file() and blob.is_file() and len(stored) == 1

bad_checksum = False
receipt = backup.publish(target, pending)
assert receipt['blobVersionId'] == '1' and receipt['manifestVersionId'] == '2'
assert receipt['key'].endswith('/manifest.json')
assert len(stored) == 2
assert operations[-2:] == [('put-object','manifest.json'), ('head-object','manifest.json')]

# New ordered recovery capsules are mandatory parts of their own manifest. A
# failed readback keeps the same pending batch; a legacy batch is still valid.
capsule = pending / backup.RECOVERY_FILENAME
capsule.write_bytes(b'synthetic encrypted recovery capsule' * 4)
record = json.loads(manifest.read_text())
record['recoveryState'] = {
    'recipientSha256':target['recipientSha256'],
    'appRevision':'b'*40, 'nativeRevision':'a'*40, 'sessionPolicy':'revoke',
    'startedAt':'2026-11-11T00:00:00+00:00', 'finishedAt':'2026-11-11T00:00:01+00:00',
    'cipherBytes':capsule.stat().st_size, 'cipherSha256':backup.file_digest(capsule),
}
record['recoveryWindow'] = {'consistency':'ordered-reconciliation-required',
    'mysqlStartedAt':'2026-11-11T00:00:02+00:00','mysqlFinishedAt':'2026-11-11T00:00:03+00:00'}
manifest.write_text(json.dumps(record))
stored.clear(); operations.clear(); bad_checksum = backup.RECOVERY_FILENAME
try:
    backup.publish(target, pending)
except backup.BackupError:
    pass
else:
    raise AssertionError('unverified recovery capsule was accepted')
assert manifest.is_file() and capsule.is_file() and blob.is_file()
assert operations == [('put-object',backup.BACKUP_FILENAME),('head-object',backup.BACKUP_FILENAME),
                      ('put-object',backup.RECOVERY_FILENAME),('head-object',backup.RECOVERY_FILENAME)]
assert stored[next(k for k in stored if k.endswith('/'+backup.BACKUP_FILENAME))]['VersionId']=='1'
bad_checksum = False
receipt = backup.publish(target, pending)
assert receipt['recoveryState']['versionId'] == '2'
assert receipt['blobVersionId'] == '1' and receipt['manifestVersionId'] == '3'
assert operations[-2:] == [('put-object','manifest.json'), ('head-object','manifest.json')]
saved_operations = operations[:]
record['recoveryWindow']['mysqlStartedAt'] = '2026-11-10T23:59:00+00:00'
manifest.write_text(json.dumps(record))
try:
    backup.publish(target, pending)
except backup.BackupError:
    pass
else:
    raise AssertionError('reversed recovery interval was accepted')
assert operations == saved_operations
record.pop('recoveryState'); record.pop('recoveryWindow')
manifest.write_text(json.dumps(record))
try:
    backup.publish(target, pending)
except backup.BackupError:
    pass
else:
    raise AssertionError('unbound recovery capsule was accepted')
assert operations == saved_operations

# A failed auxiliary capture must still produce and publish the MySQL batch.
isolation = pending / 'isolated-capture'
(isolation / 'formal').mkdir(parents=True)
(isolation / 'formal/.application-release.lock').write_text('fixture-lock')
new_pending = isolation / 'spool/pending'
new_pending.parent.mkdir()
def fake_snapshot(revision, stage, backup_key):
    assert revision == 'a'*40 and backup_key == key
    stage.mkdir()
    encrypted = stage / backup.BACKUP_FILENAME
    encrypted.write_bytes(b'synthetic mysql encrypted fixture' * 4)
    return {'revision':revision, 'database':backup.MYSQL_DATABASE, 'encrypted':True,
            'verified':True, 'cipherSha256':backup.file_digest(encrypted)}
with patch.object(backup, 'ROOT', isolation), \
        patch.object(backup.subprocess, 'check_output', return_value='true ' + 'a'*40), \
        patch.object(backup, 'wrap_backup_key', return_value=(key, wrapped_key)), \
        patch.object(backup, 'capture_recovery_state', side_effect=backup.BackupError('fixture failure')), \
        patch.object(backup, 'take_snapshot', side_effect=fake_snapshot), \
        patch.object(backup, 'utc_now', return_value=backup.datetime(2026,11,11,tzinfo=backup.timezone.utc)):
    backup.capture(target, new_pending)
new_manifest = json.loads((new_pending / backup.MANIFEST).read_text())
assert new_manifest['recoveryStateError'] == 'capture_failed'
assert 'recoveryState' not in new_manifest and (new_pending / backup.BACKUP_FILENAME).is_file()
assert not (new_pending / backup.RECOVERY_FILENAME).exists()
stored.clear(); operations.clear()
fallback_receipt = backup.publish(target, new_pending)
assert fallback_receipt['recoveryStateStatus'] == 'capture_failed'
assert fallback_receipt['blobVersionId'] and fallback_receipt['manifestVersionId']

backup.aws_json = lambda *args: {'Account':target['account'], 'Arn':f"arn:aws:iam::{target['account']}:root"}
try:
    backup.check_role(target)
except backup.BackupError:
    pass
else:
    raise AssertionError('root credentials were accepted')
`, ops, fixture], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});
