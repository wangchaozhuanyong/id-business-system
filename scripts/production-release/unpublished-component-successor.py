"""Finite API/Admin component successor of the genuine B + Admin publication.

ONLINE's historical origin is immutable. This entry has its own producer,
preflight, build, publication and receipt; it never issues an ONLINE seal.
"""

import argparse
import base64
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import zlib
from typing import Literal, TypedDict


SCOPE = 'UNPUBLISHED_API_ADMIN_COMPONENT_SUCCESSOR'
BUILD_SCOPE = 'UNPUBLISHED_COMPONENT_BUILD'
TRANSPORT_SCOPE = 'UNPUBLISHED_COMPONENT_PREFLIGHT_TRANSPORT'
PREFIX = 'unpublished-component-successor'
CONTEXT = '.deploy/production-release/' + PREFIX + '-build-context'
PROJECTION = '.deploy/production-release/' + PREFIX + '-build-projection.json'
PROOF = '.deploy/production-release/' + PREFIX + '-build-proof.json'
PREFLIGHT = '.deploy/production-release/' + PREFIX + '-preflight.json'
APPLICATION_SOURCE = 'a019e794fd6b3313fa312ad5a08fa4559f876d18'
APPLICATION_TREE = 'a0a23337d76e793347c1bd86d2679bc187cb043f'
APPROVED_APPLICATION_INPUT_SHA256 = '4b255d3214fed5825fe98e8fb337feba51c7247f63e38a573003d28c3e84b126'
APPLICATION_INPUT_COUNT = 2164
BASELINE_CONTRACT = {'adminPredecessorManifestSha256': '5263307389da5be14cb13a0c2a26b6d2ca5a8268bc9bcfce4313cf07809f0c6c',
 'adminPredecessorRelease': '/opt/id-business-v2/releases/20261012T162822Z-60e164b75d1e',
 'adminPublicationSha256': '75ab43cc2e0bdb6b2c3da66b5a411df7cc9aea2a313dc7dc1963624fa4fd564f',
 'apiImage': {'fileCount': 4244,
              'imageId': 'sha256:5c06cae77f95c7a040a9fb22afcddefa45ca28b4e47589aa38eeae5eb5b6384b',
              'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:api-recovery-hotfix-31d2c6885a45-60e164b75d1e-1544ebee4c95',
              'sha256': '8f317fd6386ef1abc585ddc3d41c3742f8d06812f75735ba12eca73c6259fd43'},
 'apiSourceCommit': '31d2c6885a45817cd40d23fce8d6145bc9f18af2',
 'apiSourceTree': '8cd7679461682d9c103e3130852431508c5e812c',
 'currentRelease': '/opt/id-business-v2/releases/20261012T182211Z-60e164b75d1e',
 'historicalB': {'manifestSha256': '84936d13d8cd241d62e606a13faf1a0d5d8fd4fa1abdfb21fb091c4298bfc382',
                 'nativeInvocationRelativePath': '.staging/api-workspace-preflight-31d2c6885a45817cd40d23fce8d6145bc9f18af2-38142818370-1/api-workspace-readback-invocation.json',
                 'nativeInvocationSha256': 'f023c717552727b06a817ec775adb48955d5934cb3b40243279c33af4ec90bf2',
                 'nativeReadbackCommandId': 'a1209a57-f27a-4fe7-8595-7c9ae2138ee8',
                 'nativeStdoutSha256': '6f783e34f10c0ec29821be9e0805a06874ac8559233e095ded5b905ed6fbbd82',
                 'proofSha256': '097721f049b91eb5abe4ca09f909858a131b93ac9de4c3b49225d60c0e76da65',
                 'recordSha256': '9387de0d7f4b093a93a87c8ac5ca7300142699cbf0cc5f05a29832c283114545',
                 'release': '/opt/id-business-v2/releases/20261011T132910Z-31d2c6885a45',
                 'sourceTree': '8cd7679461682d9c103e3130852431508c5e812c'},
 'historicalWireSha256': '47cba3fad47077f30c83d8cfe5a8907b797eeeb2fedd78e764a47a42a0849c75',
 'hotfixDecodedSha256': '074a2841006f69cf88e30920c90bdd9b810921b9e1f263576c7682e2fb8b89ea',
 'hotfixKeys': ['after',
                'afterAudit',
                'apiConfigurationSha256',
                'backup',
                'baselineApiCommit',
                'baselineEcrDigest',
                'baselineImageId',
                'before',
                'beforeAudit',
                'databaseGrantsChanged',
                'externalNotification',
                'imageId',
                'imageReference',
                'migrationPerformed',
                'newMigrations',
                'patchFiles',
                'patchSourceCommit',
                'paymentPerformed',
                'planSha256',
                'previousManifestSha256',
                'previousRelease',
                'scope',
                'servicesUpdated',
                'sqliteMaintenanceCleared',
                'sqliteProtection',
                'sqliteProtectionReceipt',
                'sqliteProtectionSha256',
                'subscriptionChanged',
                'workspaceVolume'],
 'hotfixPublicationSha256': '3466112e7ee25fa5c1783391995b02809cd9071de25d3a229b90a8a1251c1599',
 'hotfixReadbackCommandId': '14955610-f263-42f1-876f-20d6a1c4e43d',
 'hotfixReadbackInvocationBytesSha256': '65a68e0ce2d00437a5eca4fdffef0dc633338368d3c7b37dab5e4c1f43b0711f',
 'hotfixScope': 'API_RECOVERY_SINGLE_SOURCE_HOTFIX',
 'hotfixStdoutSha256': 'e306ca46d0b4aa388fda5059dbfd7ba090668c7ce38b388d4744f09457ac1a82',
 'manifestSha256': '7b081bbde167ebed1a9b94312036540471f16bb682d1f1e7ba9ff96822e4153c',
 'roles': ['admin', 'api', 'auto-recharge', 'auto-registration', 'caddy', 'media-resolver', 'mysql'],
 'services': {'admin': {'configurationSha256': '800604261c87178a7870184200843d3e14bd800620e165fc90f86f98d5b09c5e',
                        'containerId': 'f2f351a666b65f26d4d93268497914c5bc69b0e1c9b282d7f33d3f2498aed709',
                        'environmentSha256': '03ddab553858482dcbcc4a93d989902d31b41753eb155fb8162011e218bc0ad4',
                        'health': 'healthy',
                        'image': 'sha256:c473c719184e2d5e1d5aa367bb933336866ec5814069360746fa3ca07627a394',
                        'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:60e164b75d1eedaab440c17139bf9ba55de08c61-38277474762-1-admin',
                        'startedAtSha256': '6c5cad7753ab60e1dde4a9da1176fd63754c6aabe3a2e5e5776c0691e38acca7',
                        'status': 'running'},
              'api': {'configurationSha256': '8a850ab1cda5a07bef02414ac5a78254ed5fabb055c16a2f4ac9b4a570db6bf3',
                      'containerId': 'bcc954816359dcb88c940484ef2d66b3ffe7a1812ebc8f7e46d23f90286f483a',
                      'environmentSha256': '9f88452817b9343fb1751d8bfbee6e70b82d4098be9ee5034d9b3dbfc80d705c',
                      'health': 'healthy',
                      'image': 'sha256:5c06cae77f95c7a040a9fb22afcddefa45ca28b4e47589aa38eeae5eb5b6384b',
                      'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:api-recovery-hotfix-31d2c6885a45-60e164b75d1e-1544ebee4c95',
                      'startedAtSha256': '3b9f0401c6495602241253085d5f96d7a303c2273a444a48ba509518e6ad3136',
                      'status': 'running'},
              'auto-recharge': {'configurationSha256': '1c341043b62969f855cc1f5852181c949b8ea7831f8c82f15cd7364ee7767120',
                                'containerId': '0190045c800bd6cda576b66ccce0986de6792390d01cf19fe19e02cd16316f97',
                                'environmentSha256': '5169582dea47a65076d5f7a3a3defbc824fa4f772b2dc0904eb64659209757ae',
                                'health': 'healthy',
                                'image': 'sha256:5bd2ab25ebcadcd99f8d339d604e0268cec3fc2cfdac54e2a215f085e3fac00e',
                                'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:04570d75c779fd91a0933ef9416f6d62698b6b91-37694009463-1-auto-recharge',
                                'startedAtSha256': 'b54ae0f7bbf6ae90e14b78e4d86fa39ae8d5fef49c5f3a95cd4bd811e3645eda',
                                'status': 'running'},
              'auto-registration': {'configurationSha256': '0da1fad093493de7997af6d9c2c855e1e4272711eb63a3a0f36f4a3fea1fb0c8',
                                    'containerId': '16de5229289255cd47c3f9336e24aa611c0f9bbc76af2fcdfc5e5e1928d68add',
                                    'environmentSha256': 'de69bd06209b17619f8cb7ae38bace36c27dc4203c67e09fd1b8d21023fbcb17',
                                    'health': 'healthy',
                                    'image': 'sha256:759f60543c2fc5661c5d21644fdc1e9cb0e5cb39c930e9c400f869e0c72be568',
                                    'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:18e23ee1ab1a8d5c988ff6ba24149e1c741d62f8-37788833835-1-auto-recharge',
                                    'startedAtSha256': '463587855c649edc70eb7ce82744c1caf57a49d7fbbfb10206bf1531443bb229',
                                    'status': 'running'},
              'caddy': {'configurationSha256': '3662db0efe0d9d7854a52da2c4fe71e626ebc9a122d9c2da76ed497b403815a0',
                        'containerId': '0ee2a1ea26eec74fef64362fd77a69894e3dc4dddd412c38ebd59c747aa6e203',
                        'environmentSha256': '33ea62b4e1f4de93e333bdbbea4ec88904661f1cb616907b185fce31b22b7181',
                        'health': None,
                        'image': 'sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510',
                        'reference': 'caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d',
                        'startedAtSha256': '8c855d6048304bfcba4e29cbde6443070cdbbf778fe722648b491c763f285d24',
                        'status': 'running'},
              'media-resolver': {'configurationSha256': '88cfc4c67adc0d0fe78e5434d8c1ebfcaeaef7e2726f3f2b30b0d4c85e0c70cb',
                                 'containerId': '0c4fd25ba8fbf2fdab7639e680c3a3433d814cdb2d71ebd7ad39531aaa639471',
                                 'environmentSha256': '8473962ae5df6f8e5553ab658ccce662a8816f83631b221484daf5fa42e3b163',
                                 'health': 'healthy',
                                 'image': 'sha256:34c25f5474f9fdd043cfb39a838762cab9e87f88db9987d9cb9ad6706c331a56',
                                 'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:b8d643450ffa9012ccc09ead15e4681e3dee98d0-37302661631-1-media-resolver',
                                 'startedAtSha256': '8814f073adf9a0964f3beaf17b261fea765db8d0059e2425ee39fe0afdf31d1f',
                                 'status': 'running'},
              'mysql': {'configurationSha256': '47f62efcca224ee71466bf71a0337d791b9f6d8b42b024208cc3a29c6585beaf',
                        'containerId': '7e5a5abe42c5503e6196f736d532793aaec3796b7eb518f02db614d4025d0074',
                        'environmentSha256': 'bb8d63d18769016c14d8664a551d2b3da9e251701ed62f87b04cba964fc9e299',
                        'health': 'healthy',
                        'image': 'sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb',
                        'reference': 'mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb',
                        'startedAtSha256': 'de8aff8d3d7634b524828ded3df29bba37d7ef4cf817deff61402fdfcf767ec7',
                        'status': 'running'}}}
MIGRATION_NAME = '20261012143000_recharge_connection_profiles'
MIGRATION_FILE = MIGRATION_NAME + '/migration.sql'
MIGRATION_ROOT = 'apps/api/prisma-mysql/migrations'
MIGRATION_SCHEMA = 'apps/api/prisma-mysql/schema.prisma'
MIGRATION_TABLE = 'id_business_v2_recharge_connection_profiles'
MIGRATION_IDENTITY = {
    'name': MIGRATION_NAME,
    'sha256': 'b382d3207ebbffc19b07d28243505ea2d1846529d49bfe906cb07fceb8c7d53e',
    'schemaBeforeSha256': '8006d3ce6f0b44cf62f3b47bb7b4a0b14d0ddc18ddf113a5da34a901b62fb197',
    'schemaAfterSha256': '2d63ec64a4d9aa40cbacfc127857124b296919142ea96318ab196aa2e4ee07f2',
    'candidateSchemaSha256': 'e97b583106de52768ed1408090731f272d7e73a8dc318c7af277142f937a8341',
    'baselineFilesCount': 47,
    'baselineFilesSha256': '3baef4b2e1fcc1b1194d5ffa0197dabd09ee01a757abe7478e1f3488f8019a14'}
MIGRATION_MODEL = b'''model IdBusinessV2RechargeConnectionProfile {
  id            String   @id @db.Char(36)
  ownerId       String   @map("owner_id") @db.VarChar(191)
  name          String   @db.VarChar(80)
  configuration Json
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  @@unique([ownerId, name])
  @@index([ownerId, createdAt], map: "id_business_v2_recharge_connection_profiles_owner_id_created_idx")
  @@map("id_business_v2_recharge_connection_profiles")
}

'''
PROJECTION_SCOPE = 'UNPUBLISHED_COMPONENT_FINITE_PROJECTION'
IMAGE_SERVICES = ('api', 'admin', 'migrate')
SERVICES = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')
UPDATED = ('api', 'admin')
PRESERVED = tuple(n for n in SERVICES if n not in UPDATED)
LABEL = 'id-business-v2.unpublished-component-successor-projection-sha256'
HELPERS = ('remote-deploy.py', 'api-admin-scope.py', 'api-admin-pending-projection.py',
           'api-admin-readonly.py', 'api-admin-pending-receipt-wire.py',
           'online-recharge-scope.py', 'online-recharge-recovery.json',
           'admin-pending-online-release.py', 'unpublished-component-successor.py',
           'unpublished-component-successor-readonly.py')


class Producer(TypedDict):
    commit: str
    sourceTree: str
    workflowRunId: str
    workflowRunAttempt: str


class Image(TypedDict):
    reference: str
    imageId: str
    fileCount: int
    sha256: str


class BuildProof(TypedDict):
    version: Literal[1]
    scope: Literal['UNPUBLISHED_COMPONENT_BUILD']
    commit: str
    sourceTree: str
    runId: str
    runAttempt: str
    qualityRunId: str
    preflightSha256: str
    baselineSha256: str
    projection: dict
    images: dict[str, Image]
    acceptance: dict
    migration: dict


class ComponentFailure(RuntimeError):
    def __init__(self, code, receipt):
        super().__init__(code)
        self.receipt = receipt


def need(condition, code):
    if not condition:
        raise RuntimeError('UNPUBLISHED_COMPONENT_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def fingerprint(value):
    return digest(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode())


def closed_json(raw, limit=256 * 1024):
    need(type(raw) is bytes and 0 < len(raw) < limit, 'JSON_SIZE_INVALID')
    def pairs(rows):
        out = {}
        for key, value in rows:
            need(key not in out, 'JSON_DUPLICATE_KEY')
            out[key] = value
        return out
    def constant(_):
        raise RuntimeError('UNPUBLISHED_COMPONENT_JSON_CONSTANT_INVALID')
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    need(type(value) is dict, 'JSON_OBJECT_REQUIRED')
    return value


def load(name, filename):
    import importlib.util
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


def modules(d=None):
    admin = load('successor_admin_origin', 'admin-pending-online-release.py')
    d = admin.controller_module() if d is None else d
    scope, _ = d.api_admin_scope('API_ADMIN_WORKSPACE')
    return d, admin, scope, projection_module()


def projection_module():
    # Normalise only the exact reviewed 449 model before applying the immutable
    # ONLINE inverse delta, then reinsert that model. The old B/D module and its
    # reference/schema seals never acquire a broader admission rule.
    from types import SimpleNamespace
    original = load('successor_projection_source', 'api-admin-pending-projection.py')
    original.CONTEXT_PATH = CONTEXT

    def project_files(candidate, base, online, commit, tree):
        need(original.source_tree(candidate) == tree, 'CANDIDATE_TREE_CHANGED')
        normal = dict(candidate)
        need(MIGRATION_SCHEMA in normal and normal[MIGRATION_SCHEMA][1] == '100644'
             and digest(normal[MIGRATION_SCHEMA][0]) == MIGRATION_IDENTITY['candidateSchemaSha256']
             and normal[MIGRATION_SCHEMA][0].count(MIGRATION_MODEL) == 1,
             'MIGRATION_SCHEMA_CHANGED')
        normal[MIGRATION_SCHEMA] = (normal[MIGRATION_SCHEMA][0].replace(MIGRATION_MODEL, b'', 1), '100644')
        need(normal[MIGRATION_SCHEMA] == online[MIGRATION_SCHEMA], 'MIGRATION_SCHEMA_CHANGED')
        output, inherited = original.project_files(normal, base, online, commit, original.source_tree(normal))
        marker = b'model IdBusinessV2RechargeBrowserSetting {'
        need(output[MIGRATION_SCHEMA][0].count(marker) == 1, 'MIGRATION_SCHEMA_CHANGED')
        output[MIGRATION_SCHEMA] = (output[MIGRATION_SCHEMA][0].replace(marker, MIGRATION_MODEL + marker, 1), '100644')
        need(digest(output[MIGRATION_SCHEMA][0]) == MIGRATION_IDENTITY['schemaAfterSha256']
             and output.get(MIGRATION_ROOT + '/' + MIGRATION_FILE, (b'', ''))[1] == '100644'
             and digest(output.get(MIGRATION_ROOT + '/' + MIGRATION_FILE, (b'', ''))[0]) == MIGRATION_IDENTITY['sha256'],
             'MIGRATION_SOURCE_CHANGED')
        before, after = original.inventory(candidate), original.inventory(output)
        generated = copy.deepcopy(inherited['generatedFiles'])
        generated[MIGRATION_SCHEMA] = {'before': before[MIGRATION_SCHEMA], 'after': after[MIGRATION_SCHEMA]}
        unchanged = {n: row for n, row in before.items() if n not in generated and n not in inherited['removedFiles']}
        need(all(after.get(n) == row for n, row in unchanged.items())
             and set(after) == set(unchanged) | set(generated), 'UNRELATED_SOURCE_CHANGED')
        record = {'version': 1, 'scope': PROJECTION_SCOPE, 'candidateCommit': commit, 'candidateTree': tree,
            'contextPath': CONTEXT, 'candidateFilesSha256': fingerprint(before), 'outputTree': original.source_tree(output),
            'outputFilesSha256': fingerprint(after), 'unchangedFilesSha256': fingerprint(unchanged),
            'generatedFiles': generated, 'removedFiles': inherited['removedFiles'],
            'runtimeFiles': list(original.RUNTIME_FILES), 'originProjection': inherited, 'migration': dict(MIGRATION_IDENTITY)}
        record['projectionSha256'] = fingerprint(record)
        return output, record

    def validate_record(record):
        fields = {'version', 'scope', 'candidateCommit', 'candidateTree', 'contextPath', 'candidateFilesSha256',
            'outputTree', 'outputFilesSha256', 'unchangedFilesSha256', 'generatedFiles', 'removedFiles',
            'runtimeFiles', 'originProjection', 'migration', 'projectionSha256'}
        need(type(record) is dict and set(record) == fields and type(record['version']) is int
             and record['version'] == 1 and record['scope'] == PROJECTION_SCOPE and record['contextPath'] == CONTEXT
             and record['migration'] == MIGRATION_IDENTITY, 'PROJECTION_CHANGED')
        inherited = original._validate_record(record['originProjection'])
        need(record['candidateCommit'] == inherited['candidateCommit']
             and all(type(record[n]) is str and re.fullmatch('[a-f0-9]{40}', record[n])
                     for n in ('candidateCommit', 'candidateTree', 'outputTree'))
             and all(type(record[n]) is str and re.fullmatch('[a-f0-9]{64}', record[n])
                     for n in ('candidateFilesSha256', 'outputFilesSha256', 'unchangedFilesSha256', 'projectionSha256'))
             and record['removedFiles'] == inherited['removedFiles'] and record['runtimeFiles'] == list(original.RUNTIME_FILES),
             'PROJECTION_CHANGED')
        expected = copy.deepcopy(inherited['generatedFiles'])
        expected[MIGRATION_SCHEMA] = {'before': {'mode': '100644', 'sha256': MIGRATION_IDENTITY['candidateSchemaSha256']},
                                     'after': {'mode': '100644', 'sha256': MIGRATION_IDENTITY['schemaAfterSha256']}}
        need(record['generatedFiles'] == expected
             and record['projectionSha256'] == fingerprint({k: v for k, v in record.items() if k != 'projectionSha256'}),
             'PROJECTION_CHANGED')
        return record

    def project_candidate(d, candidate, commit, tree):
        return project_files(candidate, *original.source_references(d), commit, tree)

    def verify_output(files, record):
        validate_record(record)
        rows = original.inventory(files)
        need(original.source_tree(files) == record['outputTree'] and fingerprint(rows) == record['outputFilesSha256']
             and all(rows.get(n) == row['after'] for n, row in record['generatedFiles'].items())
             and not set(rows).intersection(record['removedFiles']), 'OUTPUT_CHANGED')
        return record

    def runtime_files(d, candidate, record):
        validate_record(record)
        output, expected = project_candidate(d, candidate, record['candidateCommit'], record['candidateTree'])
        need(expected == record, 'PROJECTION_SOURCE_CHANGED')
        return {n: output[n] for n in original.RUNTIME_FILES}

    def verify_context(d, context, record):
        context = Path(context).resolve()
        root = Path.cwd().resolve()
        need(context == root / CONTEXT and context.is_dir() and not any(p.is_symlink() for p in context.parents),
             'BUILD_CONTEXT_INVALID')
        rows = {}
        for path in context.rglob('*'):
            need(not path.is_symlink(), 'BUILD_CONTEXT_CHANGED')
            if path.is_file():
                rows[path.relative_to(context).as_posix()] = (path.read_bytes(), '100755' if path.stat().st_mode & 0o111 else '100644')
            else:
                need(path.is_dir(), 'BUILD_CONTEXT_CHANGED')
        verify_output(rows, record)
        return record

    return SimpleNamespace(**{**{n: getattr(original, n) for n in ('inventory', 'source_tree', 'source_references', 'RUNTIME_FILES')},
        'CONTEXT_PATH': CONTEXT,
        'project_files': project_files, 'project_candidate': project_candidate, 'verify_output': verify_output,
        'validate_record': validate_record, 'runtime_config_files': runtime_files, 'verify_build_context': verify_context})


def private_bytes(path, cap=256 * 1024):
    path = Path(path)
    need(path.is_absolute() and path.resolve() == path and not path.is_symlink(), 'PRIVATE_ARTIFACT_INVALID')
    identity = lambda row: (row.st_dev, row.st_ino, row.st_mode, row.st_nlink, row.st_uid, row.st_gid,
                            row.st_size, row.st_mtime_ns, row.st_ctime_ns)
    initial = path.lstat()
    need(stat.S_ISREG(initial.st_mode) and initial.st_nlink == 1 and initial.st_uid == os.geteuid()
         and stat.S_IMODE(initial.st_mode) == 0o600 and 0 < initial.st_size < cap, 'PRIVATE_ARTIFACT_INVALID')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        raw = stream.read(cap)
        after = os.fstat(stream.fileno())
    need(identity(initial) == identity(before) == identity(after) == identity(path.lstat())
         and len(raw) == before.st_size, 'PRIVATE_ARTIFACT_CHANGED')
    return raw


def write_private(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    need(not path.parent.is_symlink() and path.parent.resolve() == path.parent
         and stat.S_IMODE(path.parent.stat().st_mode) & 0o077 == 0,
         'PRIVATE_DIRECTORY_INVALID')
    raw = (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()
    need(len(raw) < 256 * 1024, 'JSON_SIZE_INVALID')
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    return raw


def producer(commit, tree, run, attempt):
    need(all(type(n) is str and re.fullmatch('[a-f0-9]{40}', n) for n in (commit, tree))
         and all(type(n) is str and re.fullmatch('[1-9][0-9]{0,19}', n) for n in (run, attempt)),
         'PRODUCER_INVALID')
    return Producer(commit=commit, sourceTree=tree, workflowRunId=run, workflowRunAttempt=attempt)


def source(d, p):
    raw_archive = d.registration_download(p['commit'])
    need(type(raw_archive) is bytes and 0 < len(raw_archive) <= 128 * 1024 * 1024, 'SOURCE_ARCHIVE_INVALID')
    files = d.registration_archive(raw_archive, p['commit'])
    projection = projection_module()
    need(projection.source_tree(files) == p['sourceTree'], 'SOURCE_TREE_CHANGED')
    for name in HELPERS:
        path = 'scripts/production-release/' + name
        need(path in files and files[path][0] == Path(__file__).with_name(name).read_bytes(),
             'EXECUTOR_SOURCE_CHANGED')
    rows = {n: row for n, row in projection.inventory(files).items()
            if n.startswith(('apps/api/', 'apps/admin/', 'packages/shared/')) or n in
            ('package.json', 'package-lock.json', '.dockerignore', 'tsconfig.base.json', 'deploy/nginx/admin.conf')}
    application_sha = fingerprint(rows)
    need(all(type(n) is str and re.fullmatch('[a-f0-9]{40}', n) for n in (APPLICATION_SOURCE, APPLICATION_TREE))
         and type(APPROVED_APPLICATION_INPUT_SHA256) is str
         and re.fullmatch('[a-f0-9]{64}', APPROVED_APPLICATION_INPUT_SHA256)
         and type(APPLICATION_INPUT_COUNT) is int and APPLICATION_INPUT_COUNT > 0
         and application_sha == APPROVED_APPLICATION_INPUT_SHA256
         and len(rows) == APPLICATION_INPUT_COUNT, 'APPLICATION_INPUTS_NOT_SEALED')
    output, record = projection.project_candidate(d, files, p['commit'], p['sourceTree'])
    projection.verify_output(output, record)
    return files, output, record, application_sha, digest(raw_archive)


def instance_id():
    return load('successor_instance_reader', 'online-recharge-scope.py')._declaration_instance_id()


def evidence_path(d, p):
    need(p == producer(p['commit'], p['sourceTree'], p['workflowRunId'], p['workflowRunAttempt']),
         'PRODUCER_INVALID')
    return d.BASE / '.component-evidence' / (p['commit'] + '-' + p['workflowRunId'] + '-' + p['workflowRunAttempt']) / 'preflight.json'


def image_content(d, scope, directory, service, expected):
    state = d.service_state(directory, service)
    metadata = json.loads(d.run('docker', 'image', 'inspect', state['image']))[0]
    need(state['image'] == metadata['Id'] == expected['imageId']
         and state['reference'] == expected['reference'] and metadata.get('Architecture') == 'amd64',
         'RUNNING_IMAGE_CHANGED')
    measured = scope.content_summary(d, service, d.compose(directory, 'exec', '-T', service,
        '/bin/sh', '-c', scope.content_command(service)))
    need(measured == {k: expected[k] for k in ('fileCount', 'sha256')}, 'RUNNING_CONTENT_CHANGED')
    return metadata


def configuration_body(d, state):
    """Read every configuration field and require the exact current raw digest."""
    rows = json.loads(d.run('docker', 'inspect', state['containerId']))
    need(type(rows) is list and len(rows) == 1 and rows[0].get('Id') == state['containerId']
         and rows[0].get('Image') == state['image'], 'CONFIGURATION_CONTAINER_CHANGED')
    metadata = rows[0]
    need(type(metadata.get('Config')) is dict and type(metadata.get('HostConfig')) is dict
         and type(metadata.get('Mounts')) is list and all(type(n) is dict and type(n.get('Destination')) is str
             for n in metadata['Mounts']), 'CONFIGURATION_MODEL_INVALID')
    body = {n: copy.deepcopy(metadata[n]) for n in ('Config', 'HostConfig')}
    body['Mounts'] = sorted(metadata['Mounts'], key=lambda n: n['Destination'])
    need(fingerprint(body) == state['configurationSha256'], 'CONFIGURATION_MODEL_CHANGED')
    return body


def canonical_dns_configuration(body):
    """Only the three Docker-25 restored empty DNS slices share null shape.

    Retain every other field and all nonempty DNS values. This pure operation
    supplies no restart or production authority; native authentication is separate.
    """
    need(type(body) is dict and set(body) == {'Config', 'HostConfig', 'Mounts'}
         and type(body['Config']) is dict and type(body['HostConfig']) is dict
         and type(body['Mounts']) is list, 'DNS_CONFIGURATION_INVALID')
    result = copy.deepcopy(body)
    for name in ('Dns', 'DnsOptions', 'DnsSearch'):
        if name not in result['HostConfig']:
            continue
        value = result['HostConfig'][name]
        need(value is None or type(value) is list and all(type(n) is str for n in value),
             'DNS_CONFIGURATION_INVALID')
        if value is None or value == []:
            result['HostConfig'][name] = None
    return result


def configuration_model(d, state):
    """Seal DNS shape and only automatic hostname after full raw validation."""
    body = canonical_dns_configuration(configuration_body(d, state))
    automatic = body['Config'].get('Hostname') == state['containerId'][:12]
    if automatic:
        body['Config']['Hostname'] = '<DOCKER_AUTOMATIC_CONTAINER_HOSTNAME>'
    return {'sha256': fingerprint(body), 'automaticHostname': automatic}


def migration_source_check(d, scope, directory, *, candidate):
    rows = scope.migration_files(d, directory)
    added = rows.pop(MIGRATION_FILE, None)
    online_name = '20261009093000_online_recharge/migration.sql'
    online = rows.pop(online_name, None)
    need(online == '44966182c1bf38290b01f665a4c2c863b052677c5e0024b900137f1d7f11eb95'
         and len(rows) == MIGRATION_IDENTITY['baselineFilesCount']
         and fingerprint(rows) == MIGRATION_IDENTITY['baselineFilesSha256']
         and added == (MIGRATION_IDENTITY['sha256'] if candidate else None), 'MIGRATION_SOURCE_CHANGED')
    schema = Path(directory) / MIGRATION_SCHEMA
    need(schema.is_file() and not schema.is_symlink()
         and digest(schema.read_bytes()) == MIGRATION_IDENTITY['schemaAfterSha256' if candidate else 'schemaBeforeSha256'],
         'MIGRATION_SCHEMA_CHANGED')
    return {**rows, online_name: online, **({MIGRATION_FILE: added} if candidate else {})}


def mysql_readonly(d, directory, query, *, database=None):
    database = d.current_job_database(directory) if database is None else database
    need(type(database) is str and re.fullmatch('[A-Za-z0-9_]{1,64}', database), 'DATABASE_INVALID')
    raw = d.compose(directory, 'exec', '-e', 'MYSQL_DATABASE=' + database, '-T', 'mysql', 'sh', '-c',
        'mysql --batch --skip-column-names -u root --password="$MYSQL_ROOT_PASSWORD" '
        '"$MYSQL_DATABASE" -e "' + ' '.join(query.split()) + '"', timeout=60)
    need(type(raw) is str and 0 < len(raw) < 512 * 1024, 'MIGRATION_DATABASE_INVALID')
    return closed_json(raw.encode(), 512 * 1024)


def migration_database_state(d, scope, directory, database_identity=None):
    rows = scope.migration_files(d, directory)
    added = rows.pop(MIGRATION_FILE, None)
    online = rows.pop('20261009093000_online_recharge/migration.sql', None)
    need(added in (None, MIGRATION_IDENTITY['sha256'])
         and online == '44966182c1bf38290b01f665a4c2c863b052677c5e0024b900137f1d7f11eb95'
         and len(rows) == MIGRATION_IDENTITY['baselineFilesCount']
         and fingerprint(rows) == MIGRATION_IDENTITY['baselineFilesSha256'], 'MIGRATION_SOURCE_CHANGED')
    expected = {n.split('/')[0]: sha for n, sha in rows.items() if n.endswith('/migration.sql')}
    expected.update({'20261009093000_online_recharge': online, MIGRATION_NAME: MIGRATION_IDENTITY['sha256']})
    query = """SELECT JSON_OBJECT('rows', (SELECT JSON_ARRAYAGG(JSON_OBJECT(
        'name', migration_name, 'checksum', checksum, 'finished', finished_at IS NOT NULL,
        'rolledBack', rolled_back_at IS NOT NULL)) FROM _prisma_migrations),
        'tables', (SELECT JSON_ARRAYAGG(JSON_OBJECT('engine', ENGINE, 'collation', TABLE_COLLATION))
        FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME='id_business_v2_recharge_connection_profiles'),
        'columns', (SELECT JSON_ARRAYAGG(JSON_OBJECT('name', COLUMN_NAME, 'position', ORDINAL_POSITION,
        'type', DATA_TYPE, 'columnType', COLUMN_TYPE, 'nullable', IS_NULLABLE, 'default', COLUMN_DEFAULT,
        'extra', EXTRA)) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME='id_business_v2_recharge_connection_profiles'),
        'indexes', (SELECT JSON_ARRAYAGG(JSON_OBJECT('name', INDEX_NAME, 'column', COLUMN_NAME,
        'sequence', SEQ_IN_INDEX, 'nonUnique', NON_UNIQUE, 'type', INDEX_TYPE, 'prefix', SUB_PART))
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME='id_business_v2_recharge_connection_profiles'))"""
    if database_identity is not None:
        database_identity = scope.workspace_database_identity(d, directory, database_identity)
    value = mysql_readonly(d, directory, query, **({'database': database_identity['database']} if database_identity else {}))
    need(set(value) == {'rows', 'tables', 'columns', 'indexes'} and type(value['rows']) is list
         and len(value['rows']) < 200, 'MIGRATION_DATABASE_INVALID')
    completed = {}
    for row in value['rows']:
        need(type(row) is dict and set(row) == {'name', 'checksum', 'finished', 'rolledBack'}
             and row['name'] in expected and row['checksum'] == expected[row['name']]
             and all(type(row[n]) in (bool, int) and row[n] in (0, 1) for n in ('finished', 'rolledBack'))
             and row['finished'] + row['rolledBack'] == 1, 'MIGRATION_HISTORY_CHANGED')
        if row['finished']:
            need(row['name'] not in completed, 'MIGRATION_HISTORY_CHANGED')
            completed[row['name']] = row['checksum']
    applied = MIGRATION_NAME in completed
    need(set(completed) == (set(expected) if applied else set(expected) - {MIGRATION_NAME}), 'MIGRATION_HISTORY_CHANGED')
    columns, indexes, tables = (value[n] or [] for n in ('columns', 'indexes', 'tables'))
    if applied:
        # MySQL 8 emits this expression in lowercase on some patch versions.
        columns = [{**row, 'default': 'CURRENT_TIMESTAMP(3)'}
                   if type(row) is dict and row.get('default') == 'current_timestamp(3)' else row for row in columns]
        expected_columns = [
            {'name': name, 'position': index, 'type': kind, 'columnType': full, 'nullable': 'NO',
             'default': default, 'extra': extra}
            for index, (name, kind, full, default, extra) in enumerate((
                ('id', 'char', 'char(36)', None, ''), ('owner_id', 'varchar', 'varchar(191)', None, ''),
                ('name', 'varchar', 'varchar(80)', None, ''), ('configuration', 'json', 'json', None, ''),
                ('created_at', 'datetime', 'datetime(3)', 'CURRENT_TIMESTAMP(3)', 'DEFAULT_GENERATED'),
                ('updated_at', 'datetime', 'datetime(3)', None, '')), 1)]
        expected_indexes = [
            {'name': name, 'column': column, 'sequence': index, 'nonUnique': unique, 'type': 'BTREE', 'prefix': None}
            for name, unique, names in (('PRIMARY', 0, ('id',)),
                (MIGRATION_TABLE + '_owner_id_name_key', 0, ('owner_id', 'name')),
                (MIGRATION_TABLE + '_owner_id_created_idx', 1, ('owner_id', 'created_at')))
            for index, column in enumerate(names, 1)]
        need(tables == [{'engine': 'InnoDB', 'collation': 'utf8mb4_unicode_ci'}]
             and type(columns) is list and sorted(columns, key=lambda n: n.get('position', 0)) == expected_columns
             and type(indexes) is list and sorted(indexes, key=lambda n: (n.get('name', ''), n.get('sequence', 0)))
                 == sorted(expected_indexes, key=lambda n: (n['name'], n['sequence'])), 'MIGRATION_SCHEMA_CHANGED')
    else:
        need(tables == columns == indexes == [], 'MIGRATION_SCHEMA_CHANGED')
    return {'name': MIGRATION_NAME, 'sha256': MIGRATION_IDENTITY['sha256'], 'status': 'APPLIED' if applied else 'PENDING',
        'schemaVerified': True, 'appliedMigrationsSha256': fingerprint(completed)}


def apply_migration(d, scope, previous, target, retained=None):
    migration_source_check(d, scope, previous, candidate=False)
    migration_source_check(d, scope, target, candidate=True)
    need(d.migration_plan(previous, target) == [MIGRATION_FILE], 'MIGRATION_SCOPE_CHANGED')
    before = migration_database_state(d, scope, previous)
    performed = before['status'] == 'PENDING'
    if performed:
        need(retained is None, 'MIGRATION_RETAINED_BINDING_CHANGED')
        d.compose(target, 'run', '--rm', '--no-deps', '--pull', 'never', 'migrate', timeout=600)
    else:
        need(type(retained) is dict and retained.get('migration') == before
             and retained.get('authenticated') is True, 'MIGRATION_ALREADY_APPLIED_WITHOUT_RECEIPT')
    after = migration_database_state(d, scope, target)
    need(after['status'] == 'APPLIED' and after['schemaVerified'] is True, 'MIGRATION_NOT_APPLIED')
    grants = d.sync_new_table_grants(target, [MIGRATION_FILE])
    need(type(grants) is dict and set(grants) == {'ok', 'newTableCount', 'runtimeTableCount'}
         and grants['ok'] is True and type(grants['newTableCount']) is int and grants['newTableCount'] == 1
         and type(grants['runtimeTableCount']) is int and grants['runtimeTableCount'] > 1, 'MIGRATION_GRANTS_NOT_VERIFIED')
    return {**after, 'performed': performed, 'before': before, 'grants': grants}


def audit_guard(value):
    need(type(value) is dict and set(value) == {'checkCount', 'violationCount', 'mode', 'checksSha256'}
         and type(value['checkCount']) is int and value['checkCount'] == 49
         and type(value['violationCount']) is int and value['violationCount'] == 0
         and value['mode'] == 'STRICT_ZERO_49' and re.fullmatch('[a-f0-9]{64}', value['checksSha256'] or ''),
         'STRICT_49_AUDIT_REQUIRED')


def backup_guard(value):
    need(type(value) is dict and set(value) == {'name', 'sha256', 'size', 's3Verified'}
         and type(value['name']) is str and re.fullmatch('id-business-v2-[A-Za-z0-9_.-]{1,128}\\.sql\\.gz', value['name'])
         and type(value['size']) is int and 0 < value['size'] < 1024**4
         and type(value['sha256']) is str and re.fullmatch('[a-f0-9]{64}', value['sha256'])
         and value['s3Verified'] is True, 'FRESH_S3_BACKUP_REQUIRED')
    return value


def grant_state(d, directory, *, applied):
    query = """SELECT JSON_OBJECT('tables', (SELECT JSON_ARRAYAGG(JSON_OBJECT(
        'grantee', GRANTEE, 'table', TABLE_NAME, 'privilege', PRIVILEGE_TYPE, 'grantable', IS_GRANTABLE))
        FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA=DATABASE()),
        'schema', (SELECT JSON_ARRAYAGG(JSON_OBJECT('grantee', GRANTEE,
        'privilege', PRIVILEGE_TYPE, 'grantable', IS_GRANTABLE))
        FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA=DATABASE()))"""
    value = mysql_readonly(d, directory, query)
    need(set(value) == {'tables', 'schema'} and type(value['tables']) is list and type(value['schema']) is list,
         'DATABASE_GRANTS_INVALID')
    tables, schema = value['tables'], value['schema']
    need(all(type(row) is dict and set(row) == {'grantee', 'table', 'privilege', 'grantable'}
             and all(type(n) is str for n in row.values()) for row in tables)
         and all(type(row) is dict and set(row) == {'grantee', 'privilege', 'grantable'}
                 and all(type(n) is str for n in row.values()) for row in schema), 'DATABASE_GRANTS_INVALID')
    new = [row for row in tables if row['table'] == MIGRATION_TABLE]
    expected = [{'grantee': "'id_business_app'@'%'", 'table': MIGRATION_TABLE, 'privilege': privilege, 'grantable': 'NO'}
                for privilege in ('INSERT', 'SELECT', 'UPDATE')] if applied else []
    need(sorted(new, key=fingerprint) == sorted(expected, key=fingerprint), 'DATABASE_NEW_TABLE_GRANTS_CHANGED')
    return {'preservedGrantsSha256': fingerprint(sorted([n for n in tables if n not in new], key=fingerprint)),
        'schemaGrantsSha256': fingerprint(sorted(schema, key=fingerprint)), 'newTablePrivileges': expected}


def require_grants_preserved(d, directory, evidence, *, applied):
    actual = grant_state(d, directory, applied=applied)
    need(all(actual[n] == evidence['databaseGrants'][n] for n in ('preservedGrantsSha256', 'schemaGrantsSha256')),
         'DATABASE_OLD_GRANTS_CHANGED')
    return actual


def restore_path(d, p):
    return evidence_path(d, p).with_name('restoration.json')


def create_restore_ledger(d, scope, previous, target, p, evidence, proof, gate, restored, changed, migration):
    need((changed or migration.get('status') == 'APPLIED') and len(set(changed)) == len(changed) and all(n in UPDATED for n in changed)
         and all(restored[n] == evidence['services'][n] for n in PRESERVED), 'FAULT_RESTORE_NOT_PROVEN')
    write_private(target / (PREFIX + '-restore-proof.json'), proof)
    audit = scope.strict_audit(d, previous, target / 'restore-audit.json')
    audit_guard(audit)
    value = {'version': 1, 'scope': SCOPE, 'status': 'UNPUBLISHED_COMPONENT_RESTORED_PENDING_READBACK',
        'producer': p, 'previousRelease': str(previous), 'failedRelease': str(target),
        'previousManifestBytesSha256': evidence['currentManifestBytesSha256'], 'baseline': evidence,
        'before': evidence['services'], 'after': restored, 'servicesRestored': list(reversed(changed)),
        'proofSha256': fingerprint(proof), 'sqliteProtectionSha256': fingerprint(gate.record),
        'workspaceVolume': evidence['workspaceVolume'], 'migration': migration,
        'restorationAudit': audit, 'environmentFileSha256': evidence['environmentFileSha256'],
        'configurationFilesSha256': evidence['configurationFilesSha256'],
        'onlinePublished': False, 'businessActions': 0, 'databaseRollbackPerformed': False,
        'historicalManifestsChanged': False}
    path = restore_path(d, p)
    write_private(path, value)
    return path


def restore_readback(d, p):
    d, _admin, scope, _projection = modules(d)
    raw = private_bytes(restore_path(d, p))
    value = closed_json(raw)
    fields = {'version', 'scope', 'status', 'producer', 'previousRelease', 'failedRelease',
        'previousManifestBytesSha256', 'baseline', 'before', 'after', 'servicesRestored', 'proofSha256',
        'sqliteProtectionSha256', 'workspaceVolume', 'migration', 'restorationAudit', 'environmentFileSha256',
        'configurationFilesSha256', 'onlinePublished', 'businessActions', 'databaseRollbackPerformed', 'historicalManifestsChanged'}
    need(set(value) == fields and type(value['version']) is int and value['version'] == 1 and value['scope'] == SCOPE
         and value['producer'] == p and value['status'] == 'UNPUBLISHED_COMPONENT_RESTORED_PENDING_READBACK'
         and value['onlinePublished'] is False and value['businessActions'] == 0
         and value['databaseRollbackPerformed'] is False and value['historicalManifestsChanged'] is False,
         'RESTORATION_LEDGER_CHANGED')
    current, target = Path(value['previousRelease']), Path(value['failedRelease'])
    need(current.parent == target.parent == d.BASE / 'releases'
         and current.resolve() == current and target.resolve() == target
         and (d.BASE / 'current').resolve() == current
         and digest(private_bytes(current / 'release-manifest.json')) == value['previousManifestBytesSha256'],
         'RESTORATION_CURRENT_CHANGED')
    states = scope.snapshot(d, current)
    evidence = value['baseline']
    need(value['before'] == evidence['services'] and states == value['after']
         and all(states[n] == evidence['services'][n] for n in PRESERVED), 'RESTORATION_SERVICES_CHANGED')
    for name in UPDATED:
        old, actual = evidence['services'][name], states[name]
        need(all(actual[k] == old[k] for k in ('image', 'reference', 'environmentSha256'))
             and configuration_model(d, actual) == evidence['configurationModels'][name]
             and actual['status'] == 'running' and actual['health'] == 'healthy', 'RESTORATION_IMAGE_CHANGED')
        image_content(d, scope, current, name, evidence['componentCurrentImages'][name])
    need(scope.workspace_volume(d, current, attached=True) == value['workspaceVolume'] == evidence['workspaceVolume']
         and digest(private_bytes(current / '.env.aws.production')) == value['environmentFileSha256']
         and all(digest((current / n).read_bytes()) == sha for n, sha in value['configurationFilesSha256'].items()),
         'RESTORATION_CONFIGURATION_CHANGED')
    proof = closed_json(private_bytes(target / (PREFIX + '-restore-proof.json')))
    need(fingerprint(proof) == value['proofSha256'], 'RESTORATION_PROOF_CHANGED')
    scope.workspace_sqlite_receipt(d, target, proof,
        {'before': evidence['services'], 'workspaceVolumeBefore': evidence['workspaceVolume'],
         'workspaceVolumeAfter': value['workspaceVolume'], 'sqliteProtectionSha256': value['sqliteProtectionSha256']},
        {'apiWorkspacePublication': {'sqliteProtectionSha256': value['sqliteProtectionSha256']}})
    scope.workspace_audit_protection(d, current)
    scope.workspace_idle(d, current, legacy=False)
    scope.jobs_idle(d, current)
    migration = migration_database_state(d, scope, target)
    need(all(value['migration'].get(n) == migration[n] for n in migration), 'RESTORATION_MIGRATION_CHANGED')
    audit_guard(value['restorationAudit'])
    public = d.environment_values(current / '.env.aws.production')['APP_PUBLIC_URL'].rstrip('/')
    with d.urllib.request.urlopen(public + '/api/health/ready', timeout=20) as response:
        need(response.status == 200, 'RESTORATION_PUBLIC_NOT_READY')
    need(private_bytes(restore_path(d, p)) == raw and scope.snapshot(d, current) == states
         and (d.BASE / 'current').resolve() == current, 'RESTORATION_MOVED')
    return {'version': 1, 'scope': SCOPE, 'status': 'UNPUBLISHED_COMPONENT_RESTORATION_VERIFIED',
        'producer': p, 'currentCommit': evidence['currentCommit'],
        'restorationLedgerBytesSha256': digest(raw), 'previousManifestBytesSha256': value['previousManifestBytesSha256'],
        'servicesSha256': fingerprint(states), 'workspaceVolumeSha256': fingerprint(value['workspaceVolume']),
        'sqliteProtectionSha256': value['sqliteProtectionSha256'], 'migration': migration,
        'onlinePublished': False, 'businessActions': 0, 'databaseRollbackPerformed': False}


def bind_restoration(d, raw, command_id, expected_instance):
    _invocation, receipt = validate_invocation(raw, command_id, expected_instance)
    need(receipt.get('scope') == SCOPE and receipt.get('status') == 'UNPUBLISHED_COMPONENT_RESTORATION_VERIFIED',
         'RESTORATION_RECEIPT_INVALID')
    p = receipt['producer']
    need(p == producer(p['commit'], p['sourceTree'], p['workflowRunId'], p['workflowRunAttempt'])
         and restore_readback(d, p) == receipt, 'RESTORATION_RECEIPT_CHANGED')
    path = restore_path(d, p).with_name('restoration-native-binding.json')
    binding = {'version': 1, 'scope': SCOPE, 'commandId': command_id, 'instanceId': expected_instance,
        'invocationBytesSha256': digest(raw), 'invocationRawBase64': base64.b64encode(raw).decode(),
        'receipt': receipt}
    write_private(path, binding)
    return {'status': 'UNPUBLISHED_COMPONENT_RESTORATION_NATIVE_BOUND', 'bindingPath': str(path),
        'bindingSha256': fingerprint(binding), 'businessActions': 0}


def authenticate_restoration(d, p, *, binding_sha256, command_id, invocation_sha256):
    """Accept a restored container only through a separately sealed native Q.

    The caller's source-bound baseline contract must provide all three expected
    native identities. A local forged JSON or an image match cannot supply them.
    """
    need(all(type(n) is str and re.fullmatch('[a-f0-9]{64}', n) for n in (binding_sha256, invocation_sha256)),
         'RESTORATION_BINDING_NOT_SEALED')
    value = closed_json(private_bytes(restore_path(d, p).with_name('restoration-native-binding.json')))
    need(set(value) == {'version', 'scope', 'commandId', 'instanceId', 'invocationBytesSha256', 'invocationRawBase64', 'receipt'}
         and type(value['version']) is int and value['version'] == 1 and value['scope'] == SCOPE
         and fingerprint(value) == binding_sha256 and value['commandId'] == command_id
         and value['invocationBytesSha256'] == invocation_sha256, 'RESTORATION_BINDING_CHANGED')
    raw = base64.b64decode(value['invocationRawBase64'], validate=True)
    need(digest(raw) == invocation_sha256, 'RESTORATION_INVOCATION_CHANGED')
    native, receipt = validate_invocation(raw, command_id, instance_id())
    need(native['InstanceId'] == value['instanceId'] and receipt == value['receipt'] == restore_readback(d, p)
         and receipt['producer'] == p, 'RESTORATION_RECEIPT_CHANGED')
    return {'authenticated': True, 'producer': p, 'bindingSha256': binding_sha256, 'commandId': command_id,
        'invocationBytesSha256': invocation_sha256, 'servicesSha256': receipt['servicesSha256'],
        'restorationLedgerBytesSha256': receipt['restorationLedgerBytesSha256'], 'migration': receipt['migration']}


def baseline(d, admin, scope, expected):
    current = (d.BASE / 'current').resolve()
    need(current.parent == d.BASE / 'releases' and not current.is_symlink(), 'CURRENT_PATH_INVALID')
    raw = private_bytes(current / 'release-manifest.json')
    manifest = closed_json(raw)
    need(manifest.get('commit') == expected and manifest.get('adminPublication', {}).get('commit') == expected,
         'CURRENT_ADMIN_CHANGED')
    need(type(BASELINE_CONTRACT) is dict, 'BASELINE_CONTRACT_NOT_SEALED')
    readonly = load('unpublished_authenticated_hotfix', 'unpublished-component-successor-readonly.py')
    authenticated = readonly.authenticate_hotfix(d, current, manifest, BASELINE_CONTRACT)
    need(type(authenticated) is dict and set(authenticated) == {
        'apiImage', 'apiSourceCommit', 'apiSourceTree', 'hotfixPublicationSha256',
        'hotfixReadbackCommandId', 'hotfixReadbackInvocationBytesSha256', 'services', 'restorationBinding',
        'nativeRestartBinding', 'historicalB'},
        'HOTFIX_AUTHENTICATION_INVALID')
    historical = authenticated['historicalB']
    need(type(historical) is dict and set(historical) == {'release', 'manifestSha256', 'recordSha256', 'proofSha256',
        'nativeReadbackCommandId', 'nativeInvocationSha256', 'authenticated'} and historical['authenticated'] is True,
        'B_ORIGIN_CHANGED')
    admin_dir = Path(BASELINE_CONTRACT['adminPredecessorRelease'])
    admin_manifest_raw = private_bytes(admin_dir / 'release-manifest.json')
    admin_manifest = closed_json(admin_manifest_raw)
    need(admin_dir.parent == d.BASE / 'releases' and admin_dir.resolve() == admin_dir
         and str(admin_dir) == manifest['previousRelease'] == manifest['apiHotfixPublication']['previousRelease']
         and digest(admin_manifest_raw) == BASELINE_CONTRACT['adminPredecessorManifestSha256']
             == manifest['previousManifestSha256'] == manifest['apiHotfixPublication']['previousManifestSha256']
         and admin_manifest['adminPublication'] == manifest['adminPublication']
         and admin_manifest['commit'] == expected
         and all(admin_manifest[n] == manifest[n] for n in admin.ORIGIN_MARKERS), 'ADMIN_ANCESTOR_CHANGED')
    old = Path(historical['release'])
    old_raw = private_bytes(old / 'release-manifest.json')
    original = closed_json(old_raw)
    ledger = manifest['adminPublication']
    need(old.parent == d.BASE / 'releases' and old.resolve() == old and not old.is_symlink()
         and original['commit'] == admin.BASELINE and digest(old_raw) == admin.BASELINE_MANIFEST_SHA256
         == ledger['inheritedManifestSha256']
         == admin_manifest['previousManifestSha256'] and str(old) == admin_manifest['previousRelease']
         and all(manifest[n] == original[n] for n in admin.ORIGIN_MARKERS), 'B_ORIGIN_CHANGED')
    b_record_raw = private_bytes(old / scope.STATE_FILE)
    b_proof_raw = private_bytes(old / scope.PROOF_FILE)
    b_record, b_proof = closed_json(b_record_raw), closed_json(b_proof_raw)
    scope.validate_pending_online_origin(b_record['pendingOnlineMigrationOrigin'])
    need(historical['manifestSha256'] == digest(old_raw)
         and historical['recordSha256'] == digest(b_record_raw)
         and historical['proofSha256'] == digest(b_proof_raw), 'B_ORIGIN_CHANGED')
    scope.workspace_sqlite_receipt(d, old, b_proof, b_record, original)
    # Historical B and the Admin ledger stay cold after the independent API
    # hotfix. Live API authority comes exclusively from its authenticated Q.
    states = scope.snapshot(d, current)
    need(set(states) == set(SERVICES), 'SERVICE_SET_CHANGED')
    need(states == authenticated['services'], 'HOTFIX_SERVICES_CHANGED')
    restart = authenticated['nativeRestartBinding']
    need(restart is None or type(restart) is dict and restart.get('authenticated') is True
         and restart.get('scope') == 'UNPUBLISHED_COMPONENT_SAME_CONTAINER_RESTART'
         and restart.get('servicesSha256') == fingerprint(states)
         and authenticated['restorationBinding'] is None, 'RESTART_AUTHENTICATION_INVALID')
    api = image_content(d, scope, current, 'api', authenticated['apiImage'])
    labels = api.get('Config', {}).get('Labels', {})
    need(labels.get('org.opencontainers.image.revision') == authenticated['apiSourceCommit']
         and labels.get('id-business-v2.source-tree') == authenticated['apiSourceTree'], 'API_ORIGIN_SOURCE_CHANGED')
    for n in SERVICES:
        if n not in UPDATED:
            preserved_snapshot = ledger['preservedServices'][n]['after']
            comparison = BASELINE_CONTRACT['services'][n] if restart is not None else states[n]
            need(ledger['preservedServices'][n]['before'] == preserved_snapshot
                 and all(preserved_snapshot[k] == comparison[k] for k in preserved_snapshot),
                 'PRESERVED_SERVICE_CHANGED')
    admin_proof_raw = private_bytes(admin_dir / 'admin-build-proof.json')
    admin_proof = closed_json(admin_proof_raw)
    _candidate, _out, expected_projection, runtime, _ = admin.source_projection(
        d, expected, manifest['sourceTree'])
    need(admin_proof['projection'] == ledger['projection'] == expected_projection, 'ADMIN_SOURCE_CHANGED')
    admin_image = admin_proof['image']
    metadata = json.loads(d.run('docker', 'image', 'inspect', admin_image['reference']))[0]
    need(states['admin']['image'] == metadata['Id'] == admin_image['imageId']
         and states['admin']['reference'] == admin_image['reference'] and metadata.get('Architecture') == 'amd64'
         and metadata.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.revision') == expected
         and metadata['Config']['Labels'].get('id-business-v2.source-tree') == manifest['sourceTree']
         and metadata['Config']['Labels'].get('id-business-v2.admin-pending-projection-sha256') == expected_projection['projectionSha256'],
         'ADMIN_IMAGE_CHANGED')
    admin_content = scope.content_summary(d, 'admin', d.run('docker', 'run', '--rm', '--network', 'none',
        '--read-only', '--entrypoint', '/bin/sh', admin_image['reference'], '-c', scope.content_command('admin')))
    current_images = {'api': authenticated['apiImage'], 'admin': {**admin_image, **admin_content}}
    image_content(d, scope, current, 'admin', current_images['admin'])
    for name, (contents, _mode) in runtime.items():
        need((current / name).read_bytes() == (old / name).read_bytes() == contents,
             'RUNTIME_CONFIGURATION_CHANGED')
    need(scope.jobs_idle(d, current)['registrationBusy'] is False, 'REGISTRATION_BUSY')
    volume = scope.workspace_volume(d, current, attached=True)
    need(volume == original['apiWorkspacePublication']['volume'], 'VOLUME_CHANGED')
    scope.workspace_idle(d, current, legacy=False)
    scope.workspace_audit_protection(d, current)
    scope.workspace_private_inspect(d, current, states['api']['reference'], volume['name'])
    need((d.BASE / 'current').resolve() == current and private_bytes(current / 'release-manifest.json') == raw
         and scope.snapshot(d, current) == states, 'BASELINE_MOVED')
    evidence = {'currentRelease': str(current), 'currentCommit': expected,
        'currentManifestBytesSha256': digest(raw), 'adminPublicationSha256': fingerprint(ledger),
        'adminPredecessorRelease': str(admin_dir), 'adminPredecessorManifestBytesSha256': digest(admin_manifest_raw),
        'adminBuildProofBytesSha256': digest(admin_proof_raw), 'apiOriginRelease': str(old),
        'apiOriginCommit': admin.BASELINE, 'apiOriginSourceTree': original['sourceTree'],
        'apiOriginManifestBytesSha256': digest(old_raw), 'apiOriginRecordBytesSha256': digest(b_record_raw),
        'apiOriginBuildProofBytesSha256': digest(b_proof_raw), 'apiOriginReadbackCommandId': historical['nativeReadbackCommandId'],
        'apiOriginReadbackInvocationBytesSha256': historical['nativeInvocationSha256'],
        'originMarkersSha256': fingerprint({n: original[n] for n in admin.ORIGIN_MARKERS}),
        'configurationFilesSha256': {n: digest((current / n).read_bytes()) for n in
            (*runtime, 'deploy/caddy/Caddyfile.aws', 'compose.release.json')},
        'environmentFileSha256': digest(private_bytes(current / '.env.aws.production')),
        'workspaceVolume': volume, 'services': states, 'guards': scope.jobs_idle(d, current),
        'apiCurrentSourceCommit': authenticated['apiSourceCommit'],
        'apiCurrentSourceTree': authenticated['apiSourceTree'],
        'hotfixPublicationSha256': authenticated['hotfixPublicationSha256'],
        'hotfixReadbackCommandId': authenticated['hotfixReadbackCommandId'],
        'hotfixReadbackInvocationBytesSha256': authenticated['hotfixReadbackInvocationBytesSha256'],
        'restorationBinding': authenticated['restorationBinding'],
        'nativeRestartBinding': restart,
        'componentCurrentImages': current_images,
        'configurationModels': {n: configuration_model(d, states[n]) for n in UPDATED},
        'migrationState': migration_database_state(d, scope, current)}
    evidence['databaseGrants'] = grant_state(d, current, applied=evidence['migrationState']['status'] == 'APPLIED')
    need(restart is None or evidence['migrationState'] == restart['migrationState']
         and evidence['migrationState']['status'] == 'PENDING', 'RESTART_MIGRATION_STATE_CHANGED')
    return current, manifest, evidence


def preflight(d, p, expected):
    d, admin, scope, _projection = modules(d)
    _files, _output, record, application_sha, _archive_sha = source(d, p)
    previous, _manifest, evidence = baseline(d, admin, scope, expected)
    need(evidence['migrationState']['status'] == 'PENDING'
         or type(evidence['restorationBinding']) is dict and evidence['restorationBinding'].get('authenticated') is True
            and evidence['restorationBinding'].get('migration') == evidence['migrationState'],
         'MIGRATION_ALREADY_APPLIED_WITHOUT_RECEIPT')
    need(d.shutil.disk_usage(d.BASE).free > 6 * 1024**3, 'DISK_LOW_BEFORE_PULL')
    result = {'version': 1, 'scope': SCOPE, 'status': 'UNPUBLISHED_COMPONENT_BASELINE_VERIFIED',
        'mode': 'preflight', 'producer': p, 'instanceId': instance_id(), 'baseline': evidence,
        'projectionSha256': fingerprint(record), 'applicationInputSha256': application_sha,
        'onlinePublished': False, 'migrationPerformed': False, 'businessActions': 0}
    need((d.BASE / 'current').resolve() == previous, 'BASELINE_MOVED')
    write_private(evidence_path(d, p), result)
    return result


def validate_invocation(raw, command_id, expected_instance, status='Success'):
    value = closed_json(raw, 128 * 1024)
    need(value.get('CommandId') == command_id and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command_id or '')
         and value.get('InstanceId') == expected_instance and value.get('DocumentName') == 'AWS-RunShellScript'
         and value.get('PluginName') == 'aws:runShellScript' and value.get('Status') == status
         and type(value.get('ResponseCode')) is int and value['ResponseCode'] == (0 if status == 'Success' else 1)
         and value.get('StandardErrorContent') == '' and type(value.get('StandardOutputContent')) is str
         and value.get('StandardOutputUrl') in (None, '') and value.get('StandardErrorUrl') in (None, '')
         and 0 < len(value['StandardOutputContent']) < 24000
         and all(type(value.get(n)) is str and re.fullmatch('[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|\\+00:00)', value[n])
                 for n in ('ExecutionStartDateTime', 'ExecutionEndDateTime')), 'INVOCATION_INVALID')
    from datetime import datetime, timezone, timedelta
    started, ended = (datetime.fromisoformat(value[n].replace('Z', '+00:00')) for n in ('ExecutionStartDateTime', 'ExecutionEndDateTime'))
    need(started <= ended <= datetime.now(timezone.utc) + timedelta(minutes=5), 'INVOCATION_INVALID')
    return value, closed_json(value['StandardOutputContent'].encode(), 24000)


def validate_preflight(d, transport, p, expected):
    need(set(transport) == {'version', 'scope', 'commandId', 'invocationBytesSha256', 'invocationRawBase64',
                            'invocationEncoding', 'decodedInvocationLength', 'serverReceipt'}
         and type(transport['version']) is int and transport['version'] == 1
         and transport['scope'] == TRANSPORT_SCOPE, 'PREFLIGHT_TRANSPORT_INVALID')
    raw = transport_invocation(transport)
    need(digest(raw) == transport['invocationBytesSha256'], 'PREFLIGHT_TRANSPORT_CHANGED')
    _invocation, receipt = validate_invocation(raw, transport['commandId'], instance_id())
    saved = private_bytes(evidence_path(d, p))
    need(_invocation['StandardOutputContent'].encode() == saved
         and receipt == transport['serverReceipt'] == closed_json(saved)
         and set(receipt) == {'version', 'scope', 'status', 'mode', 'producer', 'instanceId', 'baseline',
                             'projectionSha256', 'applicationInputSha256', 'onlinePublished', 'migrationPerformed', 'businessActions'}
         and type(receipt['version']) is int and receipt['version'] == 1 and receipt['scope'] == SCOPE
         and receipt['status'] == 'UNPUBLISHED_COMPONENT_BASELINE_VERIFIED' and receipt['mode'] == 'preflight'
         and receipt['producer'] == p and receipt['baseline']['currentCommit'] == expected
         and receipt['instanceId'] == _invocation['InstanceId']
         and receipt['applicationInputSha256'] == APPROVED_APPLICATION_INPUT_SHA256
         and receipt['onlinePublished'] is False and receipt['migrationPerformed'] is False
         and type(receipt['businessActions']) is int and receipt['businessActions'] == 0,
         'PREFLIGHT_CHANGED')
    return receipt


def transport_invocation(transport):
    need(transport['invocationEncoding'] == 'gzip-base64'
         and type(transport['decodedInvocationLength']) is int and 0 < transport['decodedInvocationLength'] < 128 * 1024,
         'PREFLIGHT_TRANSPORT_INVALID')
    packed = base64.b64decode(transport['invocationRawBase64'], validate=True)
    need(0 < len(packed) < 24000, 'PREFLIGHT_TRANSPORT_INVALID')
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    raw = decoder.decompress(packed, 128 * 1024)
    need(decoder.eof and not decoder.unconsumed_tail and not decoder.unused_data
         and len(raw) == transport['decodedInvocationLength']
         and digest(raw) == transport['invocationBytesSha256'], 'PREFLIGHT_TRANSPORT_CHANGED')
    return raw


def make_transport(raw, command_id, expected_instance):
    import gzip
    _invocation, receipt = validate_invocation(raw, command_id, expected_instance)
    result = {'version': 1, 'scope': TRANSPORT_SCOPE, 'commandId': command_id,
        'invocationBytesSha256': digest(raw), 'invocationRawBase64': base64.b64encode(gzip.compress(raw, mtime=0)).decode(),
        'invocationEncoding': 'gzip-base64', 'decodedInvocationLength': len(raw), 'serverReceipt': receipt}
    need(len(json.dumps(result).encode()) < 24000, 'PREFLIGHT_TRANSPORT_TOO_LARGE')
    return result


def local_preflight(transport, p):
    _invocation, receipt = validate_invocation(transport_invocation(transport), transport['commandId'],
        os.environ['PRODUCTION_INSTANCE_ID'])
    need(receipt == transport['serverReceipt'] and receipt['producer'] == p
         and receipt['baseline']['currentCommit'] == os.environ['EXPECTED_CURRENT']
         and receipt['scope'] == SCOPE and receipt['status'] == 'UNPUBLISHED_COMPONENT_BASELINE_VERIFIED'
         and receipt['applicationInputSha256'] == APPROVED_APPLICATION_INPUT_SHA256
         and receipt['onlinePublished'] is False and receipt['migrationPerformed'] is False
         and receipt['businessActions'] == 0, 'PREFLIGHT_CHANGED')
    return receipt


def prepare(d):
    d, _admin, _scope, projection = modules(d)
    p = producer(os.environ['RELEASE_COMMIT'], os.environ['SOURCE_TREE'], os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT'])
    root = Path.cwd().resolve()
    transport = closed_json(private_bytes(root / PREFLIGHT))
    receipt = local_preflight(transport, p)
    need(receipt['producer'] == p and receipt['applicationInputSha256'] == APPROVED_APPLICATION_INPUT_SHA256,
         'PREFLIGHT_CHANGED')
    _files, output, record, _sha, _archive_sha = source(d, p)
    need(receipt['projectionSha256'] == fingerprint(record), 'PROJECTION_CHANGED')
    private_root = (root / PROJECTION).parent
    private_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    need(private_root.resolve() == private_root and not private_root.is_symlink()
         and private_root.stat().st_uid == os.geteuid()
         and stat.S_IMODE(private_root.stat().st_mode) == 0o700, 'PRIVATE_DIRECTORY_INVALID')
    need(not (root / CONTEXT).exists(), 'BUILD_CONTEXT_EXISTS')
    d.write_registration_files(root / CONTEXT, output)
    projection.verify_build_context(d, root / CONTEXT, record)
    path = root / PROJECTION
    write_private(path, record)
    return record


def build_proof(d):
    d, _admin, scope, projection = modules(d)
    p = producer(os.environ['RELEASE_COMMIT'], os.environ['SOURCE_TREE'], os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT'])
    root = Path.cwd().resolve()
    transport = closed_json(private_bytes(root / PREFLIGHT))
    local_preflight(transport, p)
    record = closed_json(private_bytes(root / PROJECTION))
    _files, _output, expected, _sha, _archive_sha = source(d, p)
    need(record == expected and transport['serverReceipt']['projectionSha256'] == fingerprint(record), 'PROJECTION_CHANGED')
    projection.verify_build_context(d, Path(CONTEXT), record)
    result = {'version': 1, 'scope': BUILD_SCOPE, 'commit': p['commit'], 'sourceTree': p['sourceTree'],
        'runId': p['workflowRunId'], 'runAttempt': p['workflowRunAttempt'],
        'qualityRunId': os.environ.get('QUALITY_RUN_ID') or os.environ['RELEASE_CI_RUN_ID'],
        'preflightSha256': fingerprint(transport), 'baselineSha256': fingerprint(transport['serverReceipt']['baseline']),
        'projection': record, 'images': {}, 'migration': dict(MIGRATION_IDENTITY)}
    for name in IMAGE_SERVICES:
        reference = f"{os.environ['RELEASE_REPOSITORY']}:{p['commit']}-{p['workflowRunId']}-{p['workflowRunAttempt']}-{name}"
        image = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
        labels = image['Config'].get('Labels', {})
        need(image.get('Architecture') == 'amd64' and labels.get('org.opencontainers.image.revision') == p['commit']
             and labels.get('id-business-v2.source-tree') == p['sourceTree']
             and labels.get(LABEL) == fingerprint(record), 'BUILD_IMAGE_CHANGED')
        content = scope.content_summary(d, name, d.run('docker', 'run', '--rm', '--network', 'none',
            '--read-only', '--entrypoint', '/bin/sh', reference, '-c', scope.content_command(name)))
        if name == 'migrate':
            expected = migration_image_content(projection, _output)
            need(content == expected, 'MIGRATION_IMAGE_CONTENT_CHANGED')
        result['images'][name] = {'reference': reference, 'imageId': image['Id'], **content}
    result['acceptance'] = scope.workspace_acceptance(d, result['images']['api']['reference'], p['workflowRunId'], p['workflowRunAttempt'])
    validate_build(result, p, record, transport, result['qualityRunId'], os.environ['RELEASE_REPOSITORY'])
    write_private(root / PROOF, result)
    return result


def validate_build(value, p, record, transport, quality, repository):
    need(set(value) == {'version', 'scope', 'commit', 'sourceTree', 'runId', 'runAttempt', 'qualityRunId',
                        'preflightSha256', 'baselineSha256', 'projection', 'images', 'acceptance', 'migration'}
         and type(value['version']) is int and value['version'] == 1 and value['scope'] == BUILD_SCOPE
         and (value['commit'], value['sourceTree'], value['runId'], value['runAttempt'])
             == tuple(p[n] for n in ('commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'))
         and value['qualityRunId'] == quality and re.fullmatch('[1-9][0-9]{0,19}', quality or '')
         and value['preflightSha256'] == fingerprint(transport)
         and value['baselineSha256'] == fingerprint(transport['serverReceipt']['baseline'])
         and value['projection'] == record and value['migration'] == MIGRATION_IDENTITY
         and set(value['images']) == set(IMAGE_SERVICES), 'BUILD_PROOF_CHANGED')
    need(re.fullmatch('[0-9]{12}\\.dkr\\.ecr\\.ap-northeast-1\\.amazonaws\\.com/id-business-v2-release', repository or ''), 'REPOSITORY_CHANGED')
    for name, row in value['images'].items():
        need(set(row) == {'reference', 'imageId', 'fileCount', 'sha256'}
             and row['reference'] == f"{repository}:{p['commit']}-{p['workflowRunId']}-{p['workflowRunAttempt']}-{name}"
             and re.fullmatch('sha256:[a-f0-9]{64}', row['imageId'] or '')
             and re.fullmatch('[a-f0-9]{64}', row['sha256'] or '')
             and type(row['fileCount']) is int and 0 < row['fileCount'] < 30000, 'BUILD_IMAGE_CHANGED')
    need(value['acceptance'] == {'status': 'PASS', 'checks': ['private-health', 'packaged-resources', 'private-sqlite',
        'encrypted-storage', 'restart-persistence', 'wrong-key-rejected'], 'businessActions': 0, 'temporaryVolumeRemoved': True}, 'BUILD_ACCEPTANCE_CHANGED')
    return value


def preserve(d, scope, previous, target, evidence, *, pointer, images, all_services=False):
    need((d.BASE / 'current').resolve() == pointer
         and digest(private_bytes(previous / 'release-manifest.json')) == evidence['currentManifestBytesSha256'],
         'BASELINE_MOVED')
    need(private_bytes(previous / '.env.aws.production') == private_bytes(target / '.env.aws.production')
         and digest(private_bytes(target / '.env.aws.production')) == evidence['environmentFileSha256'], 'ENVIRONMENT_CHANGED')
    for name, sha in evidence['configurationFilesSha256'].items():
        if name == 'compose.release.json':
            continue
        if name == MIGRATION_SCHEMA:
            need(digest((previous / name).read_bytes()) == MIGRATION_IDENTITY['schemaBeforeSha256']
                 and digest((target / name).read_bytes()) == MIGRATION_IDENTITY['schemaAfterSha256'], 'MIGRATION_SCHEMA_CHANGED')
            continue
        need((previous / name).read_bytes() == (target / name).read_bytes()
             and digest((target / name).read_bytes()) == sha, 'RUNTIME_CONFIGURATION_CHANGED')
    need(d.migration_plan(previous, target) == [MIGRATION_FILE], 'MIGRATION_SCOPE_CHANGED')
    migration_source_check(d, scope, previous, candidate=False)
    migration_source_check(d, scope, target, candidate=True)
    scope.workspace_configuration(d, previous, target)
    override = closed_json(private_bytes(previous / 'compose.release.json'))
    for name in IMAGE_SERVICES:
        override['services'][name] = {'image': images[name]['reference'], 'pull_policy': 'never'}
    need(closed_json(private_bytes(target / 'compose.release.json')) == override, 'IMAGE_OVERRIDE_CHANGED')
    states = scope.snapshot(d, target)
    need(set(states) == set(SERVICES) and all(states[n] == evidence['services'][n]
         for n in SERVICES if all_services or n in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    need(scope.workspace_volume(d, target, attached=True) == evidence['workspaceVolume'], 'VOLUME_CHANGED')
    return states


def running(d, scope, target, proof):
    scope.verify_running(d, target, proof)
    for name in UPDATED:
        metadata = json.loads(d.run('docker', 'image', 'inspect', proof['images'][name]['imageId']))[0]
        need(metadata['Config']['Labels'].get(LABEL) == fingerprint(proof['projection']), 'PROJECTION_LABEL_CHANGED')


def migration_image_content(projection, files):
    rows = {('/app/' + n): digest(raw) for n, (raw, _mode) in files.items() if n.startswith('apps/api/prisma-mysql/')}
    need(rows and len(rows) < 200, 'MIGRATION_IMAGE_CONTENT_CHANGED')
    lines = sorted(sha + '  ' + n for n, sha in rows.items())
    return {'fileCount': len(lines), 'sha256': digest(('\n'.join(lines) + '\n').encode())}


def stop_failed_api(d, scope, target, proof, evidence, gate, database_identity):
    """A stopped, known container needs no signal; live tasks always forbid stop."""
    scope.jobs_idle(d, target, **({'database_identity': database_identity} if database_identity else {}))
    api = scope.workspace_api_metadata(d, target)
    scope.workspace_idle(d, target, legacy=False, api_metadata=api)
    gate.check_marker()
    need(api.get('Image') in (evidence['services']['api']['image'], proof['images']['api']['imageId'])
         and scope.workspace_volume(d, target, attached=True, api_metadata=api) == evidence['workspaceVolume'], 'API_IDENTITY_CHANGED')
    if api['Image'] == evidence['services']['api']['image']:
        need(api['Id'] == evidence['services']['api']['containerId'], 'API_IDENTITY_CHANGED')
    if api['State']['Running'] is False:
        need(api['State'].get('Pid') == 0, 'API_NOT_STOPPED')
        return
    identity = scope.workspace_api_identity(d, target)
    need(identity['containerId'] == api['Id'], 'API_IDENTITY_CHANGED')
    scope.jobs_idle(d, target, **({'database_identity': database_identity} if database_identity else {}))
    scope.workspace_idle(d, target, legacy=False)
    gate.check_marker()
    d.run('docker', 'stop', '--time', '30', identity['containerId'], timeout=45)
    stopped = json.loads(d.run('docker', 'inspect', identity['containerId']))[0]
    need(stopped['Id'] == identity['containerId'] and stopped['State']['Running'] is False
         and stopped['State']['Pid'] == 0, 'API_NOT_STOPPED')


def release(d, args, proof, transport):
    # This explicit human input is not inferred from Admin approval or any proof.
    need(args.api_fault_restore_approved is True, 'API_FAULT_RESTORE_APPROVAL_REQUIRED')
    d, admin, scope, projection = modules(d)
    p = producer(args.commit, args.source_tree, args.run_id, args.run_attempt)
    receipt = validate_preflight(d, transport, p, args.expected_current)
    files, _output, record, _sha, archive_sha = source(d, p)
    validate_build(proof, p, record, transport, args.ci_run_id, args.repository)
    need(receipt['projectionSha256'] == fingerprint(record), 'PROJECTION_CHANGED')
    os.umask(0o077)
    with (d.BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous, old, evidence = baseline(d, admin, scope, args.expected_current)
        need(evidence == receipt['baseline'], 'PREFLIGHT_BASELINE_CHANGED')
        need(d.shutil.disk_usage(d.BASE).free > 6 * 1024**3, 'DISK_LOW_BEFORE_PULL')
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        target = d.BASE / 'releases' / (stamp + '-' + p['commit'][:12])
        need(not target.exists(), 'RELEASE_EXISTS')
        changed, gate, database_identity, phase = [], None, None, 'source'
        migration_result = {'performed': False, **evidence['migrationState']}
        try:
            d.write_registration_files(target, files)
            runtime = projection.runtime_config_files(d, files, record)
            for name, (raw, mode) in runtime.items():
                saved = target / '.deploy/production-release/pending-original-source' / name
                saved.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                saved.write_bytes(files[name][0]); saved.chmod(0o600)
                (target / name).write_bytes(raw); (target / name).chmod(0o755 if mode == '100755' else 0o644)
            import shutil
            shutil.copy2(previous / '.env.aws.production', target / '.env.aws.production')
            (target / '.env.aws.production').chmod(0o600)
            override = closed_json(private_bytes(previous / 'compose.release.json'))
            for name in IMAGE_SERVICES:
                override['services'][name] = {'image': proof['images'][name]['reference'], 'pull_policy': 'never'}
            write_private(target / 'compose.release.json', override)
            preserve(d, scope, previous, target, evidence, pointer=previous, images=proof['images'], all_services=True)
            phase = 'images'
            password = d.run('aws', 'ecr', 'get-login-password', '--region', 'ap-northeast-1')
            registry = args.repository.split('/')[0]
            login = d.subprocess.run(['docker', 'login', '--username', 'AWS', '--password-stdin', registry],
                                     input=password, capture_output=True, text=True)
            need(login.returncode == 0, 'IMAGE_LOGIN_FAILED')
            try:
                for name in IMAGE_SERVICES:
                    row = proof['images'][name]
                    d.run('docker', 'pull', row['reference'], timeout=900)
                    image = json.loads(d.run('docker', 'image', 'inspect', row['reference']))[0]
                    labels = image['Config'].get('Labels', {})
                    need(image['Id'] == row['imageId'] and image.get('Architecture') == 'amd64'
                         and labels.get('org.opencontainers.image.revision') == p['commit']
                         and labels.get('id-business-v2.source-tree') == p['sourceTree']
                         and labels.get(LABEL) == fingerprint(record), 'IMAGE_PROVENANCE_CHANGED')
                    if name == 'migrate':
                        content = scope.content_summary(d, name, d.run('docker', 'run', '--rm', '--network', 'none',
                            '--read-only', '--entrypoint', '/bin/sh', row['reference'], '-c', scope.content_command(name)))
                        need(content == migration_image_content(projection, _output)
                             == {k: row[k] for k in ('fileCount', 'sha256')}, 'MIGRATION_IMAGE_CONTENT_CHANGED')
            finally:
                d.subprocess.run(['docker', 'logout', registry], capture_output=True, text=True)
            need(d.shutil.disk_usage(d.BASE).free > 2 * 1024**3, 'DISK_LOW')
            phase = 'audit-before'
            first = scope.strict_audit(d, target, target / 'before-audit.json')
            audit_guard(first)
            phase = 'backup'
            backup = d.fresh_backup(previous)
            backup_guard(backup)
            write_private(target / 'backup-verification.json', backup)
            preserve(d, scope, previous, target, evidence, pointer=previous, images=proof['images'], all_services=True)
            scope.jobs_idle(d, previous)
            scope.workspace_idle(d, previous, legacy=False)
            scope.workspace_audit_protection(d, previous)
            phase = 'sqlite-protection'
            database_identity = scope.workspace_database_identity(d, previous)
            gate = scope.workspace_prepare(d, previous, target, proof, args,
                {'workspaceVolume': evidence['workspaceVolume']}, legacy=False)
            need(gate is not None and gate.record is not None, 'SQLITE_PROTECTION_REQUIRED')
            preserve(d, scope, previous, target, evidence, pointer=previous, images=proof['images'], all_services=True)
            scope.jobs_idle(d, previous)
            gate.check_locked()
            phase = 'migration'
            migration_result = apply_migration(d, scope, previous, target, evidence['restorationBinding'])
            migration_result['grantProtection'] = require_grants_preserved(d, target, evidence, applied=True)
            migration_raw = write_private(target / (PREFIX + '-migration.json'), migration_result)
            scope.jobs_idle(d, previous)
            scope.workspace_idle(d, previous, legacy=False)
            gate.check_locked()
            phase = 'api-switch'
            changed.append('api')
            gate.stop_previous()
            d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'api', timeout=300)
            d.wait_healthy(target, 'api')
            preserve(d, scope, previous, target, evidence, pointer=previous, images=proof['images'])
            phase = 'admin-switch'
            changed.append('admin')
            d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'admin', timeout=300)
            d.wait_healthy(target, 'admin')
            running(d, scope, target, proof)
            phase = 'audit-after'
            second = scope.strict_audit(d, target, target / 'after-audit.json')
            audit_guard(second)
            need(first['checksSha256'] == second['checksSha256'], 'AUDIT_RULES_CHANGED')
            after = preserve(d, scope, previous, target, evidence, pointer=previous, images=proof['images'])
            state = {'version': 1, 'scope': SCOPE, 'before': evidence['services'], 'after': after,
                'baseline': evidence, 'proofSha256': fingerprint(proof), 'projectionSha256': fingerprint(record),
                'workspaceVolumeBefore': evidence['workspaceVolume'], 'workspaceVolumeAfter': scope.workspace_volume(d, target, attached=True),
                'sqliteProtectionSha256': fingerprint(gate.record), 'onlinePublished': False, 'migrationPerformed': migration_result['performed'],
                'migration': migration_result,
                'businessActions': 0}
            state_raw = write_private(target / (PREFIX + '-preservation.json'), state)
            proof_raw = write_private(target / (PREFIX + '-build-proof.json'), proof)
            write_private(target / (PREFIX + '-preflight.json'), transport)
            ledger = {'version': 1, 'scope': SCOPE, 'producer': p, 'baseline': evidence,
                'componentBefore': {'api': evidence['apiCurrentSourceCommit'], 'admin': args.expected_current},
                'componentAfter': {'api': args.commit, 'admin': args.commit},
                'preflightSha256': fingerprint(transport), 'buildProofBytesSha256': digest(proof_raw),
                'preservationRecordBytesSha256': digest(state_raw), 'sqliteProtectionSha256': fingerprint(gate.record),
                'migrationRecordBytesSha256': digest(migration_raw),
                'originMarkersSha256': evidence['originMarkersSha256'], 'originMarkersRole': 'INHERITED_B_HISTORICAL_ORIGIN',
                'applicationSourceCommit': APPLICATION_SOURCE, 'applicationInputSha256': APPROVED_APPLICATION_INPUT_SHA256,
                'sourceArchiveSha256': archive_sha, 'sourceFilesSha256': fingerprint(projection.inventory(files)),
                'projectionSha256': fingerprint(record), 'servicesUpdated': list(UPDATED),
                'onlinePublished': False, 'migrationPerformed': migration_result['performed'], 'databaseGrantsChanged': True,
                'migration': migration_result, 'businessActions': 0}
            manifest = copy.deepcopy(old)
            manifest.update(commit=args.commit, sourceTree=args.source_tree, sourceBranch='main',
                previousCommit=args.expected_current, previousRelease=str(previous), previousManifestSha256=evidence['currentManifestBytesSha256'],
                releaseTag='v2-production-' + stamp, deployedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                ciWorkflowRunId=int(args.ci_run_id), deploymentRun=f'github-actions-{args.run_id}-{args.run_attempt}',
                imageBuildRun=f'github-actions-{args.run_id}-{args.run_attempt}', servicesUpdated=list(UPDATED),
                sourceArchiveSha256=archive_sha,
                backupBeforeRelease=backup['name'], migrationApplied=True, migrationPerformed=migration_result['performed'], newMigrations=[MIGRATION_FILE],
                dataAuditBefore=first, dataAuditAfter=second, apiComponentPublication=ledger,
                databaseGrants={'status': 'VERIFIED', 'newTables': [MIGRATION_TABLE], 'report': migration_result['grants']},
                rollback={'release': str(previous), 'scope': 'API_ADMIN_COMPONENT_STARTUP_FAULT_RESTORE',
                          'images': {n: evidence['services'][n]['image'] for n in UPDATED}, 'servicesAdded': []})
            # The Admin origin remains historical too; its original ledger is unchanged.
            for name in IMAGE_SERVICES:
                manifest['images'][name] = {'reference': proof['images'][name]['reference'],
                    'digest': proof['images'][name]['imageId'], 'sourceCommit': args.commit}
            need(all(manifest[n] == old[n] for n in admin.ORIGIN_MARKERS)
                 and manifest['adminPublication'] == old['adminPublication']
                 and manifest['apiHotfixPublication'] == old['apiHotfixPublication'], 'ORIGIN_MARKER_CHANGED')
            write_private(target / 'release-manifest.json', manifest)
            phase = 'readback'
            d.point_current(target, args.run_id)
            result = readback(d, args.commit)
            gate.finish()
            result.update(sqliteMaintenanceReleased=True, backupVerified=True)
            return result
        except Exception as error:
            if gate is None:
                gate = getattr(error, 'sqlite_gate', None)
            if gate is not None:
                gate.close()
            recovery = {'status': 'NOT_REQUIRED' if not changed else 'UNKNOWN', 'services': {}}
            # An accepted task always wins over fault restore, even with approval.
            try:
                if phase not in ('source', 'images', 'audit-before', 'backup', 'sqlite-protection'):
                    observed = migration_database_state(d, scope, target, database_identity)
                    migration_result = {**migration_result, **observed,
                        'performed': evidence['migrationState']['status'] == 'PENDING' and observed['status'] == 'APPLIED'}
                if changed:
                    scope.jobs_idle(d, target, **({'database_identity': database_identity} if database_identity else {}))
                    api = scope.workspace_api_metadata(d, target)
                    scope.workspace_idle(d, target, legacy=False, api_metadata=api)
                    need(gate is not None, 'SQLITE_PROTECTION_REQUIRED')
                    gate.check_marker()
                    scope.workspace_private_inspect(d, target, proof['images']['api']['reference'],
                        gate.volume['name'], expected=gate.summary['logicalSha256'])
                    for name in reversed(changed):
                        if name == 'api':
                            # The same marker still rejects worker mutations; do not close any business task.
                            stop_failed_api(d, scope, target, proof, evidence, gate, database_identity)
                        d.rollback_service(previous, target, name, evidence['services'])
                        recovery['services'][name] = 'RESTORED'
                    restored = scope.snapshot(d, previous)
                    need(all(restored[n] == evidence['services'][n] for n in PRESERVED)
                         and all(restored[n]['image'] == evidence['services'][n]['image']
                                 and restored[n]['reference'] == evidence['services'][n]['reference']
                                 and restored[n]['environmentSha256'] == evidence['services'][n]['environmentSha256']
                                 and configuration_model(d, restored[n]) == evidence['configurationModels'][n]
                                 and restored[n]['status'] == 'running' and restored[n]['health'] == 'healthy' for n in UPDATED)
                         and scope.workspace_volume(d, previous, attached=True) == evidence['workspaceVolume']
                         and digest(private_bytes(previous / '.env.aws.production')) == evidence['environmentFileSha256']
                         and all(digest((previous / n).read_bytes()) == sha for n, sha in evidence['configurationFilesSha256'].items()),
                         'FAULT_RESTORE_NOT_PROVEN')
                    restore_record = create_restore_ledger(d, scope, previous, target, p, evidence, proof, gate,
                        restored, changed, migration_result)
                    gate.abort()
                    if (d.BASE / 'current').resolve() == target:
                        d.point_current(previous, args.run_id + '-api-component-restore')
                    recovery.update(status='RESTORED', restorationLedgerPath=str(restore_record),
                        independentReadbackRequired=True)
                elif gate is not None:
                    if migration_result.get('status') == 'APPLIED':
                        record = create_restore_ledger(d, scope, previous, target, p, evidence, proof, gate,
                            scope.snapshot(d, previous), [], migration_result)
                        recovery.update(status='SERVICES_UNCHANGED_MIGRATION_RETAINED', restorationLedgerPath=str(record),
                            independentReadbackRequired=True)
                    gate.abort()
            except Exception:
                recovery['status'] = 'BLOCKED_OR_FAILED'
            code = str(error)
            if not re.fullmatch('UNPUBLISHED_COMPONENT_[A-Z0-9_]+', code):
                code = 'UNPUBLISHED_COMPONENT_PROTECTED_OPERATION_FAILED'
            failure = {'version': 1, 'scope': SCOPE, 'status': 'UNPUBLISHED_COMPONENT_FAILED',
                'phase': phase, 'code': code, 'candidateCommit': args.commit, 'previousCommit': args.expected_current,
                'servicesAttempted': changed, 'recovery': recovery, 'onlinePublished': False,
                'migrationPerformed': migration_result.get('performed'), 'migration': migration_result,
                'businessActions': 0, 'receiptPersisted': False,
                'currentRelease': 'UNAVAILABLE'}
            try:
                failure['actualServices'] = scope.snapshot(d, previous)
                failure['currentRelease'] = str((d.BASE / 'current').resolve())
            except Exception:
                failure['actualServices'] = {'status': 'UNAVAILABLE'}
            try:
                failure['receiptPersisted'] = True
                write_private(target / (PREFIX + '-failure.json'), failure)
            except Exception:
                failure['receiptPersisted'] = False
            d._apiComponentFailure = failure
            raise ComponentFailure(code, failure) from None


def readback(d, commit):
    d, admin, scope, projection = modules(d)
    current = (d.BASE / 'current').resolve()
    manifest_raw = private_bytes(current / 'release-manifest.json')
    manifest = closed_json(manifest_raw)
    ledger = manifest.get('apiComponentPublication', {})
    need(manifest.get('commit') == commit == ledger.get('producer', {}).get('commit')
         and ledger.get('scope') == SCOPE and manifest.get('servicesUpdated') == list(UPDATED)
         and manifest.get('migrationApplied') is True and manifest.get('newMigrations') == [MIGRATION_FILE]
         and ledger.get('componentAfter') == {'api': commit, 'admin': commit}
         and ledger.get('onlinePublished') is False and type(ledger.get('migrationPerformed')) is bool
         and ledger.get('migrationPerformed') is manifest.get('migrationPerformed')
         and ledger.get('databaseGrantsChanged') is True and ledger.get('businessActions') == 0,
         'READBACK_CHANGED')
    p = ledger['producer']
    need(p == producer(p['commit'], p['sourceTree'], p['workflowRunId'], p['workflowRunAttempt'])
         and p['sourceTree'] == manifest['sourceTree'], 'PRODUCER_CHANGED')
    proof_raw = private_bytes(current / (PREFIX + '-build-proof.json'))
    state_raw = private_bytes(current / (PREFIX + '-preservation.json'))
    proof, state = closed_json(proof_raw), closed_json(state_raw)
    transport = closed_json(private_bytes(current / (PREFIX + '-preflight.json')))
    evidence = validate_preflight(d, transport, p, manifest['previousCommit'])['baseline']
    _files, _output, record, _sha, _archive_sha = source(d, p)
    repository = proof['images']['api']['reference'].rsplit(':', 1)[0]
    validate_build(proof, p, record, transport, str(manifest['ciWorkflowRunId']), repository)
    need(ledger['baseline'] == evidence == state['baseline'] and state['before'] == evidence['services']
         and ledger['buildProofBytesSha256'] == digest(proof_raw)
         and ledger['preservationRecordBytesSha256'] == digest(state_raw)
         and ledger['preflightSha256'] == fingerprint(transport)
         and ledger['projectionSha256'] == state['projectionSha256'] == fingerprint(record)
         and ledger['applicationInputSha256'] == APPROVED_APPLICATION_INPUT_SHA256
         and ledger['applicationSourceCommit'] == APPLICATION_SOURCE
         and ledger['sourceArchiveSha256'] == manifest['sourceArchiveSha256']
         and re.fullmatch('[a-f0-9]{64}', ledger['sourceArchiveSha256'])
         and ledger['sourceFilesSha256'] == fingerprint(projection.inventory(_files))
         and ledger['componentBefore'] == {'api': evidence['apiCurrentSourceCommit'], 'admin': manifest['previousCommit']}, 'PUBLICATION_CHANGED')
    previous = Path(manifest['previousRelease'])
    before_manifest = closed_json(private_bytes(previous / 'release-manifest.json'))
    need(previous == Path(evidence['currentRelease']) and before_manifest['commit'] == manifest['previousCommit']
         and all(manifest[n] == before_manifest[n] for n in admin.ORIGIN_MARKERS)
         and manifest['adminPublication'] == before_manifest['adminPublication']
         and manifest['apiHotfixPublication'] == before_manifest['apiHotfixPublication']
         and fingerprint({n: manifest[n] for n in admin.ORIGIN_MARKERS}) == evidence['originMarkersSha256']
         == ledger['originMarkersSha256'] and ledger['originMarkersRole'] == 'INHERITED_B_HISTORICAL_ORIGIN', 'ORIGIN_MARKER_CHANGED')
    states = preserve(d, scope, previous, current, evidence, pointer=current, images=proof['images'])
    need(states == state['after'], 'READBACK_SERVICE_CHANGED')
    running(d, scope, current, proof)
    migration_raw = private_bytes(current / (PREFIX + '-migration.json'))
    migration = closed_json(migration_raw)
    actual_migration = migration_database_state(d, scope, current)
    need(digest(migration_raw) == ledger['migrationRecordBytesSha256']
         and migration == ledger['migration'] == state['migration']
         and migration['performed'] is ledger['migrationPerformed']
         and all(migration.get(n) == actual_migration[n] for n in actual_migration)
         and actual_migration['status'] == 'APPLIED'
         and migration['grantProtection'] == require_grants_preserved(d, current, evidence, applied=True),
         'MIGRATION_RECEIPT_CHANGED')
    row = proof['images']['migrate']
    metadata = json.loads(d.run('docker', 'image', 'inspect', row['reference']))[0]
    need(metadata['Id'] == row['imageId'] and metadata['Architecture'] == 'amd64'
         and metadata.get('Config', {}).get('Labels', {}).get(LABEL) == fingerprint(record), 'MIGRATION_IMAGE_CHANGED')
    measured = scope.content_summary(d, 'migrate', d.run('docker', 'run', '--rm', '--network', 'none',
        '--read-only', '--entrypoint', '/bin/sh', row['reference'], '-c', scope.content_command('migrate')))
    need(measured == migration_image_content(projection, _output)
         == {n: row[n] for n in ('fileCount', 'sha256')}, 'MIGRATION_IMAGE_CONTENT_CHANGED')
    scope.workspace_sqlite_receipt(d, current, proof, state,
        {'apiWorkspacePublication': {'sqliteProtectionSha256': ledger['sqliteProtectionSha256']}})
    scope.workspace_audit_protection(d, current)
    public = d.environment_values(current / '.env.aws.production')['APP_PUBLIC_URL'].rstrip('/')
    for path in ('/', '/api/health/ready'):
        with d.urllib.request.urlopen(public + path, timeout=20) as response:
            need(response.status == 200, 'PUBLIC_NOT_READY')
            if path == '/':
                need(('v2-' + commit).encode() in response.read(4 * 1024 * 1024), 'PUBLIC_VERSION_CHANGED')
    need((d.BASE / 'current').resolve() == current and private_bytes(current / 'release-manifest.json') == manifest_raw,
         'CURRENT_MOVED')
    return {'version': 1, 'scope': SCOPE, 'status': 'UNPUBLISHED_COMPONENT_VERIFIED', 'commit': commit,
        'sourceTree': p['sourceTree'], 'servicesUpdated': list(UPDATED), 'preservedServiceCount': len(PRESERVED),
        'componentBefore': ledger['componentBefore'], 'componentAfter': ledger['componentAfter'],
        'manifestBytesSha256': digest(manifest_raw), 'publicationSha256': fingerprint(ledger),
        'buildProofBytesSha256': digest(proof_raw), 'preservationRecordBytesSha256': digest(state_raw),
        'sqliteProtectionSha256': ledger['sqliteProtectionSha256'], 'projectionSha256': fingerprint(record),
        'runningImagesAndContentMatched': True, 'volumeDeletionPerformed': False,
        'onlinePublished': False, 'migrationPerformed': ledger['migrationPerformed'], 'migration': actual_migration,
        'databaseOldGrantsPreserved': True, 'businessActions': 0}


def cli(d=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('prepare', 'proof', 'preflight', 'readback', 'release', 'restore-readback', 'bind-restoration'))
    for name in ('commit', 'source-tree', 'repository', 'expected-current', 'run-id', 'run-attempt', 'ci-run-id', 'build-proof', 'preflight'):
        parser.add_argument('--' + name)
    parser.add_argument('--api-fault-restore-approved', action='store_true')
    parser.add_argument('--restore-invocation')
    parser.add_argument('--restore-command-id')
    args = parser.parse_args()
    if args.operation == 'release':
        need(args.api_fault_restore_approved is True, 'API_FAULT_RESTORE_APPROVAL_REQUIRED')
        need(all(value is not None for key, value in vars(args).items()
                 if key not in ('api_fault_restore_approved', 'restore_invocation', 'restore_command_id'))
             and args.restore_invocation is None and args.restore_command_id is None, 'SELECTION_INVALID')
        proof = closed_json(base64.b64decode(args.build_proof, validate=True), 128 * 1024)
        transport = closed_json(base64.b64decode(args.preflight, validate=True), 24576)
        return release(d, args, proof, transport)
    need(args.api_fault_restore_approved is False, 'SELECTION_INVALID')
    if args.operation == 'bind-restoration':
        need(args.restore_invocation is not None and args.restore_command_id is not None
             and all(value is None for key, value in vars(args).items()
                     if key not in ('operation', 'api_fault_restore_approved', 'restore_invocation', 'restore_command_id')),
             'SELECTION_INVALID')
        d = modules(d)[0]
        return bind_restoration(d, base64.b64decode(args.restore_invocation, validate=True), args.restore_command_id, instance_id())
    need(args.restore_invocation is None and args.restore_command_id is None, 'SELECTION_INVALID')
    if args.operation == 'restore-readback':
        need(all(getattr(args, n) is not None for n in ('commit', 'source_tree', 'run_id', 'run_attempt'))
             and all(getattr(args, n) is None for n in ('repository', 'expected_current', 'ci_run_id', 'build_proof', 'preflight')),
             'SELECTION_INVALID')
        return restore_readback(d, producer(args.commit, args.source_tree, args.run_id, args.run_attempt))
    if args.operation in ('prepare', 'proof'):
        need(all(value is None for key, value in vars(args).items() if key not in ('operation', 'api_fault_restore_approved')), 'SELECTION_INVALID')
        result = prepare(d) if args.operation == 'prepare' else build_proof(d)
        return {'status': 'UNPUBLISHED_COMPONENT_BUILD_PREPARED' if args.operation == 'prepare' else 'UNPUBLISHED_COMPONENT_BUILD_PROVEN',
                'proofSha256': fingerprint(result)}
    if args.operation == 'readback':
        need(args.commit is not None and all(value is None for key, value in vars(args).items()
             if key not in ('operation', 'api_fault_restore_approved', 'commit')), 'SELECTION_INVALID')
        return readback(d, args.commit)
    need(all(getattr(args, n) is not None for n in ('commit', 'source_tree', 'expected_current', 'run_id', 'run_attempt'))
         and all(getattr(args, n) is None for n in ('repository', 'ci_run_id', 'build_proof', 'preflight')), 'SELECTION_INVALID')
    return preflight(d, producer(args.commit, args.source_tree, args.run_id, args.run_attempt), args.expected_current)


if __name__ == '__main__':
    try:
        print(json.dumps(cli(), sort_keys=True, separators=(',', ':')))
    except Exception as error:
        code = str(error) if re.fullmatch('UNPUBLISHED_COMPONENT_[A-Z0-9_]+', str(error)) else 'UNPUBLISHED_COMPONENT_UNAVAILABLE'
        result = {'version': 1, 'scope': SCOPE, 'status': 'UNPUBLISHED_COMPONENT_FAILED', 'code': code,
                  'onlinePublished': False, 'migrationPerformed': False, 'businessActions': 0}
        if isinstance(error, ComponentFailure):
            result = error.receipt
        print(json.dumps(result, sort_keys=True, separators=(',', ':')))
        raise SystemExit(1) from None
