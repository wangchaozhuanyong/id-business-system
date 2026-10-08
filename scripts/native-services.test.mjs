import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  checkInstalledNativeServices,
  nativeServiceBundle,
  nativeServiceHealth,
  nativeServicesMain,
  parseNativeServicesOptions,
  services,
  writeNativeServiceBundle
} from './native-services.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.entries({
  'release-dir': '/opt/id-business-v2/releases/candidate',
  'config-dir': '/etc/id-business-v2-native',
  'private-config-dir': '/etc/id-business-v2-secrets',
  'state-dir': '/var/lib/id-business-v2-native',
  'runtime-dir': '/run/id-business-v2-native',
  node: '/opt/id-business-v2/tools/node/bin/node',
  'worker-python': '/opt/id-business-v2/tools/worker/bin/python',
  'media-python': '/opt/id-business-v2/tools/media/bin/python',
  'f2-python': '/opt/id-business-v2/tools/f2/bin/python',
  'engine-path': '/opt/id-business-v2/browser/camoufox',
  'xvfb-run': '/usr/bin/xvfb-run',
  nginx: '/usr/sbin/nginx',
  'nginx-mime-types': '/etc/nginx/mime.types',
  caddy: '/usr/bin/caddy',
  mysqld: '/usr/sbin/mysqld',
  mysql: '/usr/bin/mysql',
  'yt-dlp': '/opt/id-business-v2/tools/yt-dlp/bin/yt-dlp',
  ffmpeg: '/usr/bin/ffmpeg'
}).map(([name, value]) => `--${name}=${value}`);
const options = () => parseNativeServicesOptions(args);

test('默认结构预检只读取三个公开源契约，不读取秘密或调用安装/启动/健康', async () => {
  const output = [];
  assert.equal(
    await nativeServicesMain(args, {
      log: (line) => output.push(line),
      installedCheck: () => assert.fail('unexpected host inspection'),
      write: () => assert.fail('unexpected output'),
      health: () => assert.fail('unexpected request')
    }),
    0
  );
  assert.match(output.join('\n'), /未写文件、未读取私有配置/);
  const readPaths = [];
  nativeServiceBundle(options(), (path, encoding) => {
    readPaths.push(path);
    return readFileSync(path, encoding);
  });
  assert.deepEqual(
    readPaths.map((path) => path.slice(projectDir.length + 1)),
    ['deploy/nginx/admin.conf', 'deploy/caddy/Caddyfile.aws', 'docker-compose.aws-mysql.yml']
  );
});

test('六服务独立非 root 账号、私有目录、固定角色端口与停止进程组', () => {
  const bundle = nativeServiceBundle(options());
  assert.equal(Object.keys(bundle.manifest.services).length, 6);
  assert.equal(new Set(Object.values(bundle.manifest.services).map((spec) => spec.user)).size, 6);
  for (const service of services) {
    const unit = bundle.files[`systemd/id-business-v2-${service}.service`];
    const bounded = ['api', 'recharge', 'media'].includes(service);
    assert.match(unit, new RegExp(`User=idv2-${service}\\n`));
    assert.match(unit, /ProtectSystem=strict\n/);
    assert.match(unit, new RegExp(`PrivateTmp=${bounded ? 'false' : 'true'}\\n`));
    assert.match(unit, /KillMode=control-group\n/);
    assert.match(unit, /StateDirectoryMode=0700\n/);
    assert.match(unit, /RuntimeDirectoryMode=0700\n/);
    assert.match(
      unit,
      new RegExp(`TMPDIR=${bounded ? '/tmp' : `/run/id-business-v2-native/${service}`} `)
    );
    assert.match(
      unit,
      new RegExp(`EnvironmentFile=/etc/id-business-v2-secrets/${service}/service.env`)
    );
    assert.match(unit, new RegExp(`--health=${service} --wait=45`));
    assert.doesNotMatch(unit, /docker|sudo|User=root|chown|chmod|migrate deploy/i);
  }
  const recharge = bundle.files['systemd/id-business-v2-recharge.service'];
  assert.equal(bundle.files['systemd/id-business-v2-registration.service'], undefined);
  assert.match(recharge, /env AUTO_RECHARGE_WORKER_ROLE=recharge /);
  assert.match(recharge, /xvfb-run -n 91 /);
  assert.match(recharge, /--host=127\.0\.0\.1 --port=8051 /);
  assert.match(
    bundle.files['systemd/id-business-v2-api.service'],
    /AUTO_RECHARGE_WORKER_URL=http:\/\/127\.0\.0\.1:8051/
  );
  assert.match(
    bundle.files['systemd/id-business-v2-media.service'],
    /F2_PYTHON=.*PATH=.*yt-dlp\/bin/
  );
  assert.match(
    bundle.files['systemd/id-business-v2-media.service'],
    /--f2-bridge=.*\/f2_bridge\.py/
  );
});

test('API、浏览器与媒体的临时 tmpfs 限额沿用 Compose，共享内存独立限额', () => {
  const bundle = nativeServiceBundle(options());
  const compose = readFileSync(resolve(projectDir, 'docker-compose.aws-mysql.yml'), 'utf8');
  for (const [service, composeName] of [
    ['api', 'api'],
    ['recharge', 'auto-recharge'],
    ['media', 'media-resolver']
  ]) {
    const contract = compose.match(
      new RegExp(`  ${composeName}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|$)`)
    )[1];
    const size = Number(contract.match(/\/tmp:rw,noexec,nosuid,nodev,size=(\d+)m/)[1]);
    const unit = bundle.files[`systemd/id-business-v2-${service}.service`];
    const directives = unit.split('\n').filter((line) => line.startsWith('TemporaryFileSystem='));
    assert.equal(directives.length, 1);
    assert.deepEqual(directives[0].slice('TemporaryFileSystem='.length).split(' '), [
      `/tmp:rw,noexec,nosuid,nodev,size=${size}M,mode=1777`,
      '/var/tmp:ro,noexec,nosuid,nodev,size=1M,mode=1777',
      '/dev/shm:rw,noexec,nosuid,nodev,size=256M,mode=1777'
    ]);
    if (['recharge'].includes(service)) assert.match(contract, /shm_size: 256m/);
    assert.deepEqual(bundle.manifest.services[service].temporaryStorage, {
      directory: '/tmp',
      maxBytes: size * 1024 * 1024,
      sharedMemoryMaxBytes: 256 * 1024 * 1024,
      varTmpReadOnly: true,
      runtimeReadOnly: true,
      linuxRuntime: 'NOT_MEASURED'
    });
    // systemd 252 会优先保留 PrivateTmp 的绑定而丢弃同路径 tmpfs，不能叠加两者。
    assert.equal(
      unit
        .split('\n')
        .filter((line) => line.startsWith('PrivateTmp='))
        .join(),
      'PrivateTmp=false'
    );
    assert.doesNotMatch(unit, /BindPaths=.*\/tmp|uid=|gid=|JoinsNamespaceOf=/);
  }
});

test('受限角色 HOME/TMPDIR 使用容量目录，宿主私有 runtime 不成为另一条可写临时路径', () => {
  const bundle = nativeServiceBundle(options());
  for (const service of ['api', 'recharge', 'media']) {
    const unit = bundle.files[`systemd/id-business-v2-${service}.service`];
    const runtime = `/run/id-business-v2-native/${service}`;
    assert.match(unit, /Environment=HOME=\/tmp TMPDIR=\/tmp /);
    assert.ok(
      unit
        .split('\n')
        .includes(`ReadOnlyPaths=${options()['release-dir']} ${options()['config-dir']} ${runtime}`)
    );
    assert.ok(
      unit.split('\n').includes(`ReadWritePaths=/var/lib/id-business-v2-native/${service}`)
    );
    assert.match(unit, /RuntimeDirectoryMode=0700\n/);
    assert.doesNotMatch(unit, new RegExp(`TemporaryFileSystem=.*${runtime}`));
  }
  for (const service of ['recharge']) {
    const unit = bundle.files[`systemd/id-business-v2-${service}.service`];
    assert.match(unit, /MemoryMax=1G\nMemorySwapMax=512M\nTasksMax=512\n/);
  }
  assert.match(
    bundle.files['systemd/id-business-v2-media.service'],
    /MemoryMax=768M\nTasksMax=128\n/
  );
});

test('MySQL、管理端及网关的宿主可见 socket/PID 目录不被临时 tmpfs 覆盖', () => {
  const bundle = nativeServiceBundle(options());
  for (const service of ['mysql', 'admin', 'caddy']) {
    const unit = bundle.files[`systemd/id-business-v2-${service}.service`];
    const runtime = `/run/id-business-v2-native/${service}`;
    assert.match(unit, new RegExp(`Environment=HOME=${runtime} TMPDIR=${runtime} `));
    assert.match(unit, /PrivateTmp=true\n/);
    assert.ok(
      unit
        .split('\n')
        .includes(`ReadWritePaths=/var/lib/id-business-v2-native/${service} ${runtime}`)
    );
    assert.doesNotMatch(unit, /TemporaryFileSystem=/);
    assert.equal(bundle.manifest.services[service].temporaryStorage, undefined);
  }
  assert.equal(bundle.manifest.linuxRuntime, 'NOT_MEASURED');
  assert.match(
    bundle.files.Caddyfile,
    /admin unix\/\/run\/id-business-v2-native\/caddy\/admin\.sock\n/
  );
});

test('管理端保留 SSE、媒体超时、缓存、客户端头；Caddy 保留安全头和域名变量', () => {
  const bundle = nativeServiceBundle(options());
  const nginx = bundle.files['nginx.conf'];
  assert.match(nginx, /listen 127\.0\.0\.1:8080;/);
  assert.match(nginx, /proxy_read_timeout 1h;/);
  assert.match(nginx, /proxy_read_timeout 370s;/);
  assert.match(nginx, /proxy_read_timeout 120s;/);
  assert.match(nginx, /X-Forwarded-For \$http_x_forwarded_for/);
  assert.match(nginx, /no-cache, no-transform/);
  assert.match(nginx, /public, max-age=31536000, immutable/);
  assert.doesNotMatch(nginx, /http:\/\/api:3000|\/usr\/share\/nginx\/html/);
  const caddy = bundle.files.Caddyfile;
  assert.match(caddy, /\{\$APP_DOMAIN\}/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8080/);
  assert.match(caddy, /Content-Security-Policy/);
  assert.match(caddy, /Strict-Transport-Security/);
  assert.match(caddy, /storage file_system \/var\/lib\/id-business-v2-native\/caddy\/storage/);
  assert.match(caddy, /persist_config off/);
  assert.match(caddy, /admin unix\/\/run\/id-business-v2-native\/caddy\/admin\.sock\n/);
  assert.doesNotMatch(caddy, /2019|admin off|http_port|https_port/);
  assert.equal(
    caddy.slice(caddy.indexOf('}\n') + 2),
    readFileSync(resolve(projectDir, 'deploy/caddy/Caddyfile.aws'), 'utf8').replaceAll(
      'reverse_proxy admin:80',
      'reverse_proxy 127.0.0.1:8080'
    )
  );
  assert.equal(bundle.manifest.services.caddy.port, null);
  assert.equal(
    bundle.manifest.services.caddy.adminSocket,
    '/run/id-business-v2-native/caddy/admin.sock'
  );
  assert.match(
    bundle.files['systemd/id-business-v2-caddy.service'],
    /--health=caddy --wait=45 --runtime-dir=\/run\/id-business-v2-native\n/
  );
  assert.equal(bundle.manifest.linuxRuntime, 'NOT_MEASURED');
  assert.match(bundle.files['mysql.cnf'], /utf8mb4_0900_ai_ci/);
  assert.match(
    bundle.files['mysql.cnf'],
    /ANSI_QUOTES,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION/
  );
  assert.doesNotMatch(
    JSON.stringify(bundle),
    /MYSQL_ROOT_PASSWORD=|AUTO_RECHARGE_WORKER_TOKEN=|JWT_SECRET=/
  );
});

test('未知服务、相交目录、注入、相对/非规范路径和缺参数均失败', () => {
  for (const extra of [
    ['--role=recharge'],
    ['--service=unknown', '--installed-check'],
    ['--write', '--check'],
    ['--health=registration', '--port=8051']
  ])
    assert.throws(() => parseNativeServicesOptions([...args, ...extra]));
  for (const [name, value] of [
    ['node', '/bin/node\nUser=root'],
    ['node', '/bin/$(secret)'],
    ['node', '/bin/%secret'],
    ['node', 'relative'],
    ['node', '/opt/../bin/node'],
    ['release-dir', '/'],
    ['runtime-dir', '/tmp/runtime'],
    ['state-dir', '/tmp/state'],
    ['config-dir', '/etc/id-business-v2-secrets/nested'],
    ['yt-dlp', '/tools/renamed-downloader']
  ]) {
    assert.throws(() =>
      parseNativeServicesOptions([
        ...args.filter((arg) => !arg.startsWith(`--${name}=`)),
        `--${name}=${value}`
      ])
    );
  }
  assert.throws(() =>
    parseNativeServicesOptions(args.filter((arg) => !arg.startsWith('--engine-path=')))
  );
  assert.throws(() => parseNativeServicesOptions(['--health=mysql']));
});

test('Caddy 健康入口只接受自己的 /run 根路径，并把它交给同一健康调用', async () => {
  for (const argv of [
    ['--health=caddy'],
    ['--health=caddy', '--runtime-dir=/tmp/private'],
    ['--health=caddy', '--runtime-dir=/run/nested/private'],
    ['--health=caddy', '--runtime-dir=/run/private/../other'],
    ['--health=caddy', '--runtime-dir=/run/private', '--mysql=/usr/bin/mysql'],
    ['--health=api', '--runtime-dir=/run/private']
  ])
    assert.throws(() => parseNativeServicesOptions(argv));
  const calls = [];
  assert.equal(
    await nativeServicesMain(['--health=caddy', '--runtime-dir=/run/id-business-v2-native'], {
      health: async (...values) => {
        calls.push(values);
        return true;
      },
      log: () => {}
    }),
    0
  );
  assert.deepEqual(calls, [
    [
      'caddy',
      {
        mysql: undefined,
        privateConfigDir: undefined,
        runtimeDir: '/run/id-business-v2-native'
      }
    ]
  ]);
});

function caddyHealthFixture({ unsafe, redirect, status = 200, error, responseError } = {}) {
  const runtimeDir = '/run/id-business-v2-native';
  const directory = `${runtimeDir}/caddy`;
  const socket = `${directory}/admin.sock`;
  const records = {
    [runtimeDir]: { type: 'directory', uid: 0, mode: 0o755 },
    [directory]: { type: 'directory', uid: 104, mode: 0o700 },
    [socket]: { type: 'socket', uid: 104, mode: 0o200 }
  };
  for (const [path, changes] of Object.entries(unsafe ?? {})) {
    records[path] = { ...records[path], ...changes };
  }
  const calls = [];
  let tcpCalls = 0;
  let resumes = 0;
  return {
    calls,
    tcpCalls: () => tcpCalls,
    resumes: () => resumes,
    dependencies: {
      runtimeDir,
      userId: () => 104,
      realPath: (path) => (path === redirect ? '/run/other/caddy/admin.sock' : path),
      stat: (path) => {
        const record = records[path];
        assert.ok(record, 'only the fixed Caddy paths may be inspected');
        if (record.missing)
          throw Object.assign(new Error('synthetic-private-detail'), { code: 'ENOENT' });
        return {
          ...record,
          isDirectory: () => record.type === 'directory',
          isSocket: () => record.type === 'socket',
          isSymbolicLink: () => record.type === 'symlink'
        };
      },
      fetcher: async () => {
        tcpCalls += 1;
        throw new Error('TCP fallback is forbidden');
      },
      socketRequest: (options, callback) => {
        calls.push(options);
        const client = new EventEmitter();
        client.end = () => {
          queueMicrotask(() => {
            if (error) return client.emit('error', new Error('synthetic-private-detail'));
            const response = new EventEmitter();
            response.statusCode = status;
            response.resume = () => {
              resumes += 1;
              if (responseError)
                response.emit(responseError, new Error('synthetic-private-detail'));
              else response.emit('end');
            };
            callback(response);
          });
        };
        return client;
      }
    }
  };
}

test('Caddy 健康只读固定私有 socket，丢弃配置响应且不接触 TCP', async () => {
  const fixture = caddyHealthFixture();
  assert.equal(await nativeServiceHealth('caddy', fixture.dependencies), true);
  assert.equal(fixture.tcpCalls(), 0);
  assert.equal(fixture.resumes(), 1);
  const [options] = fixture.calls;
  assert.equal(options.socketPath, '/run/id-business-v2-native/caddy/admin.sock');
  assert.equal(options.method, 'GET');
  assert.equal(options.path, '/config/');
  assert.deepEqual(options.headers, { Host: 'localhost' });
  assert.equal(options.agent, false);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.host, undefined);
  assert.equal(options.port, undefined);
});

test('Caddy 非私有/错误属主/软链/缺失 socket 与 HTTP 失败均关闭，不回退端口', async () => {
  const runtimeDir = '/run/id-business-v2-native';
  const directory = `${runtimeDir}/caddy`;
  const socket = `${directory}/admin.sock`;
  for (const changes of [
    { unsafe: { [runtimeDir]: { uid: 104 } } },
    { unsafe: { [runtimeDir]: { mode: 0o775 } } },
    { unsafe: { [directory]: { mode: 0o755 } } },
    { unsafe: { [directory]: { uid: 105 } } },
    { unsafe: { [directory]: { type: 'symlink' } } },
    { unsafe: { [socket]: { mode: 0o222 } } },
    { unsafe: { [socket]: { uid: 105 } } },
    { unsafe: { [socket]: { type: 'file' } } },
    { unsafe: { [socket]: { missing: true } } },
    { redirect: runtimeDir },
    { redirect: directory },
    { redirect: socket }
  ]) {
    const fixture = caddyHealthFixture(changes);
    assert.equal(await nativeServiceHealth('caddy', fixture.dependencies), false);
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.tcpCalls(), 0);
  }
  for (const changes of [
    { status: 301 },
    { status: 204 },
    { status: 503 },
    { error: true },
    { responseError: 'error' },
    { responseError: 'aborted' }
  ]) {
    const fixture = caddyHealthFixture(changes);
    assert.equal(await nativeServiceHealth('caddy', fixture.dependencies), false);
    assert.equal(fixture.tcpCalls(), 0);
  }
  for (const userId of [() => 0, () => undefined]) {
    const fixture = caddyHealthFixture();
    assert.equal(await nativeServiceHealth('caddy', { ...fixture.dependencies, userId }), false);
    assert.equal(fixture.calls.length, 0);
  }
});

function installedFixture({ missing, unsafe, duplicateUid, symlink, rootUid } = {}) {
  const opts = options();
  const privateBase = opts['private-config-dir'];
  const binaryPaths = new Set(
    [
      'node',
      'worker-python',
      'media-python',
      'f2-python',
      'engine-path',
      'xvfb-run',
      'nginx',
      'caddy',
      'mysqld',
      'mysql',
      'yt-dlp',
      'ffmpeg'
    ].map((name) => opts[name])
  );
  const roleUid = (service) => services.indexOf(service) + 10001;
  const filePaths = new Set([
    ...Object.entries(opts)
      .filter(([name]) => !name.endsWith('-dir'))
      .map(([, path]) => path),
    ...['nginx.conf', 'Caddyfile', 'mysql.cnf'].map((path) => `${opts['config-dir']}/${path}`),
    `${opts['release-dir']}/apps/api/dist/main.js`,
    `${opts['release-dir']}/apps/admin/dist/index.html`,
    `${opts['release-dir']}/apps/api/src/id-business-v2/auto-recharge/worker/server.py`,
    `${opts['release-dir']}/apps/api/src/id-business-v2/workspace/media-resolver/server.py`,
    `${opts['release-dir']}/apps/api/src/id-business-v2/workspace/media-resolver/f2_bridge.py`,
    `${opts['release-dir']}/scripts/native-services.mjs`,
    ...services.map((service) => `${privateBase}/${service}/service.env`),
    `${privateBase}/mysql/health.cnf`
  ]);
  const directory = (path) =>
    !filePaths.has(path) ||
    ['release-dir', 'config-dir', 'private-config-dir'].some((name) => path === opts[name]) ||
    /\/mysql\/data$|\/caddy\/storage$/.test(path) ||
    services.some((service) => path === `${privateBase}/${service}`);
  function stat(path) {
    if (path === missing) throw new Error('synthetic-private-error');
    const role = services.find(
      (service) => path.includes(`/${service}/`) || path.endsWith(`/${service}`)
    );
    const privateRolePath = path.startsWith(`${privateBase}/`);
    const statePath = path.startsWith(opts['state-dir']);
    return {
      mode:
        path === unsafe
          ? 0o777
          : privateRolePath || statePath
            ? directory(path)
              ? 0o700
              : 0o600
            : 0o755,
      uid: !binaryPaths.has(path) && (privateRolePath || statePath) && role ? roleUid(role) : 0,
      isFile: () => !directory(path),
      isDirectory: () => directory(path),
      isSymbolicLink: () => path === symlink
    };
  }
  return {
    platform: 'linux',
    stat,
    executableStat: stat,
    realPath: (path) => path,
    userId: (user) => (rootUid ? 0 : duplicateUid ? 10001 : roleUid(user.replace('idv2-', '')))
  };
}

test('Linux 安装预检缺秘密文件、源码或独立用户时关闭；Mac 不假装 systemd 已运行', () => {
  assert.equal(checkInstalledNativeServices(options(), installedFixture()).ok, true);
  for (const settings of [
    { missing: '/etc/id-business-v2-secrets/recharge/service.env' },
    { missing: '/etc/id-business-v2-native/nginx.conf' },
    { missing: '/opt/id-business-v2/releases/candidate/apps/admin/dist/index.html' },
    { missing: '/etc/id-business-v2-secrets/mysql/health.cnf' },
    { unsafe: '/etc/id-business-v2-secrets/recharge/service.env' },
    { symlink: '/etc/id-business-v2-secrets/media/service.env' },
    { unsafe: '/opt/id-business-v2/tools' },
    { duplicateUid: true },
    { rootUid: true }
  ])
    assert.equal(checkInstalledNativeServices(options(), installedFixture(settings)).ok, false);
  assert.equal(
    checkInstalledNativeServices(options(), {
      platform: 'darwin',
      stat: () => assert.fail('no host path reads')
    }).ok,
    false
  );
  for (const alias of [
    '/opt/id-business-v2/releases/candidate',
    '/etc/id-business-v2-secrets/recharge'
  ]) {
    const fixture = installedFixture();
    fixture.realPath = (path) => (path === alias ? '/unapproved/alias' : path);
    assert.equal(checkInstalledNativeServices(options(), fixture).ok, false);
  }
  assert.equal(
    checkInstalledNativeServices(options(), installedFixture()).artifactIdentity,
    'UNSEALED_NOT_ADMITTED'
  );
});

test('输出仅写本项目新隔离目录，权限及摘要可读回，拒绝覆盖、软链接与越界', () => {
  const base = resolve(projectDir, '.runtime/docker-independence-20261008');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(resolve(base, 'native-service-test-'));
  try {
    const output = resolve(root, '.runtime/candidate');
    const bundle = nativeServiceBundle(options());
    assert.equal(writeNativeServiceBundle(bundle, output, { root }), output);
    assert.equal(lstatSync(output).mode & 0o777, 0o700);
    for (const [path, fingerprint] of Object.entries(bundle.manifest.files)) {
      assert.equal(lstatSync(resolve(output, path)).mode & 0o777, 0o600);
      assert.equal(
        createHash('sha256')
          .update(readFileSync(resolve(output, path)))
          .digest('hex'),
        fingerprint
      );
    }
    assert.throws(() => writeNativeServiceBundle(bundle, output, { root }));
    assert.throws(() => writeNativeServiceBundle(bundle, resolve(root, 'outside'), { root }));
    mkdirSync(resolve(root, 'destination'));
    symlinkSync(resolve(root, 'destination'), resolve(root, '.runtime/link'));
    assert.throws(() =>
      writeNativeServiceBundle(bundle, resolve(root, '.runtime/link/child'), { root })
    );
    assert.throws(() =>
      writeNativeServiceBundle(
        { files: { '../outside': 'synthetic' } },
        resolve(root, '.runtime/invalid'),
        { root }
      )
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('公开源模板变化即停止，不静默生成遗漏代理行为的配置', () => {
  assert.throws(() => nativeServiceBundle(options(), () => 'changed public template'));
});

test('已退役注册服务在任何请求前停止', async () => {
  assert.equal(
    await nativeServiceHealth('registration', {
      fetcher: () => assert.fail('retired service must not make requests')
    }),
    false
  );
  assert.throws(() => parseNativeServicesOptions(['--health=registration']));
  assert.equal(services.includes('registration'), false);
});

test('充值健康保留角色校验和独立授权查询', async () => {
  const token = 'synthetic-native-worker-authorization-32';
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/health')
      ? { ok: true, json: async () => ({ ok: true, workerRole: 'recharge' }) }
      : { status: 404, body: { cancel: async () => {} } };
  };
  assert.equal(
    await nativeServiceHealth('recharge', {
      environment: { AUTO_RECHARGE_WORKER_TOKEN: token },
      fetcher
    }),
    true
  );
  assert.equal(calls[0].url, 'http://127.0.0.1:8051/health');
  assert.equal(calls[1].init.headers['X-Recharge-Worker'], token);
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal(
    await nativeServiceHealth('recharge', {
      environment: { AUTO_RECHARGE_WORKER_TOKEN: token },
      fetcher: async () => ({ ok: true, json: async () => ({ ok: true, workerRole: 'other' }) })
    }),
    false
  );
  assert.equal(
    await nativeServiceHealth('recharge', {
      environment: {},
      fetcher: () => assert.fail('缺少授权不发起请求')
    }),
    false
  );
});

test('MySQL 健康只引用私有客户端文件，不把密码放参数或输出', async () => {
  const calls = [];
  assert.equal(
    await nativeServiceHealth('mysql', {
      mysql: '/usr/bin/mysql',
      privateConfigDir: '/etc/id-business-v2-secrets',
      run: (...values) => {
        calls.push(values);
        return { status: 0, stdout: '1\n' };
      }
    }),
    true
  );
  assert.deepEqual(calls[0][1], [
    '--defaults-extra-file=/etc/id-business-v2-secrets/mysql/health.cnf',
    '--no-login-paths',
    '--host=127.0.0.1',
    '--port=3306',
    '--protocol=TCP',
    '--batch',
    '--skip-column-names',
    '--execute=SELECT 1'
  ]);
  assert.equal(calls[0][2].shell, false);
  assert.deepEqual(calls[0][2].stdio, ['ignore', 'pipe', 'pipe']);
  for (const result of [
    { status: 1, stdout: '', stderr: 'Access denied synthetic-secret' },
    { status: 0, stdout: '' },
    { status: 0, stdout: 'private-details' }
  ]) {
    assert.equal(
      await nativeServiceHealth('mysql', {
        mysql: '/usr/bin/mysql',
        privateConfigDir: '/etc/id-business-v2-secrets',
        run: () => result
      }),
      false
    );
  }
  const output = [];
  assert.equal(
    await nativeServicesMain(['--health=media'], {
      health: () => {
        throw new Error('synthetic-secret');
      },
      log: (line) => output.push(line)
    }),
    1
  );
  assert.equal(output.join('\n').includes('synthetic-secret'), false);
});
