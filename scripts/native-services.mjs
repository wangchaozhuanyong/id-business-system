import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const services = Object.freeze([
  'mysql',
  'api',
  'admin',
  'caddy',
  'recharge',
  'registration',
  'media'
]);
export const ports = Object.freeze({
  mysql: 3306,
  api: 3000,
  admin: 8080,
  caddy: null,
  recharge: 8051,
  registration: 8052,
  media: 8787
});
const pathNames = [
  'release-dir',
  'config-dir',
  'private-config-dir',
  'state-dir',
  'runtime-dir',
  'node',
  'worker-python',
  'media-python',
  'f2-python',
  'engine-path',
  'xvfb-run',
  'nginx',
  'nginx-mime-types',
  'caddy',
  'mysqld',
  'mysql',
  'yt-dlp',
  'ffmpeg'
];
const workerEntry = 'apps/api/src/id-business-v2/auto-recharge/worker/server.py';
const mediaEntry = 'apps/api/src/id-business-v2/workspace/media-resolver/server.py';
const bridgeEntry = 'apps/api/src/id-business-v2/workspace/media-resolver/f2_bridge.py';
const temporaryMiB = Object.freeze({ api: 64, recharge: 512, registration: 512, media: 640 });
const sha = (value) => createHash('sha256').update(value).digest('hex');
const unitName = (service) => `id-business-v2-${service}.service`;
const userName = (service) => `idv2-${service}`;
const beneath = (base, path) =>
  path !== base && !relative(base, path).startsWith('..') && !isAbsolute(relative(base, path));

function targetPath(value) {
  if (!value || !/^\/[A-Za-z0-9._/-]+$/.test(value) || value === '/' || resolve(value) !== value) {
    throw new Error('部署路径须为明确且规范的绝对路径，不允许空白、插值或路径穿越');
  }
  return value;
}

function caddyAdminSocket(runtimeDir) {
  targetPath(runtimeDir);
  if (dirname(runtimeDir) !== '/run') throw new Error('Caddy 运行目录须直属 /run');
  return `${runtimeDir}/caddy/admin.sock`;
}

export function parseNativeServicesOptions(argv) {
  const values = {};
  const flags = new Set(['check', 'write', 'installed-check', 'help']);
  const names = new Set([...pathNames, 'output-dir', 'service', 'health', 'wait']);
  for (let index = 0; index < argv.length; index += 1) {
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(argv[index]);
    if (!match || match[1] in values) throw new Error('原生服务参数无效或重复');
    const name = match[1];
    if (flags.has(name)) {
      if (match[2] !== undefined) throw new Error('原生服务开关不接受值');
      values[name] = true;
    } else if (names.has(name)) {
      const value = match[2] ?? argv[++index];
      if (!value || value.startsWith('--')) throw new Error('原生服务参数缺少值');
      values[name] = value;
    } else throw new Error('未知原生服务参数');
  }
  if (values.help) return values;
  if (values.health) {
    const healthPaths =
      values.health === 'mysql'
        ? ['mysql', 'private-config-dir']
        : values.health === 'caddy'
          ? ['runtime-dir']
          : [];
    if (
      !services.includes(values.health) ||
      Object.keys(values).some((name) => !['health', 'wait', ...healthPaths].includes(name))
    ) {
      throw new Error('健康检查服务或参数无效');
    }
    const wait = values.wait ?? '0';
    if (!/^\d+$/.test(wait) || Number(wait) > 60) throw new Error('健康检查等待时间无效');
    values.wait = Number(wait);
    if (values.health === 'mysql') {
      targetPath(values.mysql);
      targetPath(values['private-config-dir']);
    }
    if (values.health === 'caddy') caddyAdminSocket(values['runtime-dir']);
    return values;
  }
  if (values.write && (values.check || values['installed-check']))
    throw new Error('生成与预检必须分开执行');
  if (values.service && (!values['installed-check'] || !services.includes(values.service)))
    throw new Error('服务预检范围无效');
  if (values.wait !== undefined) throw new Error('等待参数仅用于健康检查');
  for (const name of pathNames) targetPath(values[name]);
  if (dirname(values['state-dir']) !== '/var/lib' || dirname(values['runtime-dir']) !== '/run') {
    throw new Error('状态目录须直属 /var/lib，运行目录须直属 /run');
  }
  const roots = ['release-dir', 'config-dir', 'private-config-dir', 'state-dir', 'runtime-dir'].map(
    (name) => values[name]
  );
  if (
    roots.some((path, index) =>
      roots.some(
        (other, otherIndex) => index !== otherIndex && (path === other || beneath(path, other))
      )
    )
  ) {
    throw new Error('源码、配置、秘密、状态和运行目录必须独立');
  }
  if (basename(values['yt-dlp']) !== 'yt-dlp' || basename(values.ffmpeg) !== 'ffmpeg')
    throw new Error('媒体可执行文件名必须沿用 yt-dlp 和 ffmpeg');
  if (values.write && (!values['output-dir'] || !isAbsolute(values['output-dir'])))
    throw new Error('生成须明确指定本项目内的隔离输出目录');
  return values;
}

function replaceContract(source, before, after) {
  if (!source.includes(before)) throw new Error('现有服务配置契约已变化，须先核对');
  return source.replaceAll(before, after);
}

export function nativeServiceBundle(options, read = readFileSync) {
  const nginxSource = read(resolve(projectDir, 'deploy/nginx/admin.conf'), 'utf8');
  const caddySource = read(resolve(projectDir, 'deploy/caddy/Caddyfile.aws'), 'utf8');
  const composeSource = read(resolve(projectDir, 'docker-compose.aws-mysql.yml'), 'utf8');
  let admin = replaceContract(nginxSource, 'listen 80;', 'listen 127.0.0.1:8080;');
  admin = replaceContract(
    admin,
    'root /usr/share/nginx/html;',
    `root ${options['release-dir']}/apps/admin/dist;`
  );
  admin = replaceContract(admin, 'http://api:3000', 'http://127.0.0.1:3000');
  const adminRuntime = `${options['runtime-dir']}/admin`;
  const files = {
    'nginx.conf': `pid ${adminRuntime}/nginx.pid;\nerror_log stderr warn;\nworker_processes auto;\nevents { worker_connections 1024; }\nhttp {\n  include ${options['nginx-mime-types']};\n  default_type application/octet-stream;\n  access_log off;\n  client_body_temp_path ${adminRuntime}/body;\n  proxy_temp_path ${adminRuntime}/proxy;\n  fastcgi_temp_path ${adminRuntime}/fastcgi;\n  uwsgi_temp_path ${adminRuntime}/uwsgi;\n  scgi_temp_path ${adminRuntime}/scgi;\n${admin}\n}\n`,
    Caddyfile: `{\n  admin unix/${caddyAdminSocket(options['runtime-dir'])}\n  persist_config off\n  storage file_system ${options['state-dir']}/caddy/storage\n}\n${replaceContract(caddySource, 'reverse_proxy admin:80', 'reverse_proxy 127.0.0.1:8080')}`,
    'mysql.cnf': `[mysqld]\nbind-address=127.0.0.1\nport=3306\nmysqlx-bind-address=127.0.0.1\nmysqlx-port=33060\ndatadir=${options['state-dir']}/mysql/data\nsocket=${options['runtime-dir']}/mysql/mysql.sock\npid-file=${options['runtime-dir']}/mysql/mysql.pid\nlog-error=${options['state-dir']}/mysql/error.log\ncharacter-set-server=utf8mb4\ncollation-server=utf8mb4_0900_ai_ci\ndefault-time-zone=+00:00\nsql-mode=ANSI_QUOTES,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION\nlog-bin-trust-function-creators=1\n`
  };
  const specs = {};
  for (const service of services) {
    const state = `${options['state-dir']}/${service}`;
    const runtime = `${options['runtime-dir']}/${service}`;
    const temporarySize = temporaryMiB[service];
    const temporaryRoot = temporarySize ? '/tmp' : runtime;
    // PrivateTmp 的绑定优先于同路径 tmpfs；有容量限制的角色直接使用私有 tmpfs。
    const temporaryFilesystems = temporarySize
      ? `TemporaryFileSystem=/tmp:rw,noexec,nosuid,nodev,size=${temporarySize}M,mode=1777 /var/tmp:ro,noexec,nosuid,nodev,size=1M,mode=1777 /dev/shm:rw,noexec,nosuid,nodev,size=256M,mode=1777\n`
      : '';
    const environmentFile = `${options['private-config-dir']}/${service}/service.env`;
    const health = `${options.node} ${options['release-dir']}/scripts/native-services.mjs --health=${service} --wait=45${service === 'mysql' ? ` --mysql=${options.mysql} --private-config-dir=${options['private-config-dir']}` : service === 'caddy' ? ` --runtime-dir=${options['runtime-dir']}` : ''}`;
    const specsForRole = {
      mysql: {
        start: `${options.mysqld} --defaults-file=${options['config-dir']}/mysql.cnf`,
        pre: `${options.mysqld} --defaults-file=${options['config-dir']}/mysql.cnf --validate-config`,
        cwd: state
      },
      api: {
        start: `/usr/bin/env NODE_ENV=production AUTH_PROVIDER=local APP_PORT=3000 AUTO_RECHARGE_WORKER_URL=http://127.0.0.1:8051 AUTO_REGISTRATION_WORKER_URL=http://127.0.0.1:8052 ID_BUSINESS_V2_MEDIA_RESOLVER_URL=http://127.0.0.1:8787 ${options.node} ${options['release-dir']}/apps/api/dist/main.js --host=127.0.0.1`,
        after: ['mysql', 'media'],
        cwd: options['release-dir']
      },
      admin: {
        start: `${options.nginx} -c ${options['config-dir']}/nginx.conf -g "daemon off;"`,
        pre: `${options.nginx} -t -c ${options['config-dir']}/nginx.conf`,
        after: ['api'],
        cwd: runtime
      },
      caddy: {
        start: `${options.caddy} run --config ${options['config-dir']}/Caddyfile --adapter caddyfile`,
        after: ['admin'],
        cwd: state
      },
      recharge: {
        start: `/usr/bin/env AUTO_RECHARGE_WORKER_ROLE=recharge AUTO_RECHARGE_CALLBACK_URL=http://127.0.0.1:3000/api/id-business-v2/auto-recharge/internal ${options['xvfb-run']} -n 91 -e /dev/stderr -s "-screen 0 1280x1024x24 -nolisten tcp" ${options['worker-python']} -B ${options['release-dir']}/${workerEntry} --host=127.0.0.1 --port=8051 --engine-path=${options['engine-path']}`,
        cwd: runtime
      },
      registration: {
        start: `/usr/bin/env AUTO_RECHARGE_WORKER_ROLE=registration AUTO_RECHARGE_CALLBACK_URL=http://127.0.0.1:3000/api/id-business-v2/auto-recharge/internal ${options['xvfb-run']} -n 92 -e /dev/stderr -s "-screen 0 1280x1024x24 -nolisten tcp" ${options['worker-python']} -B ${options['release-dir']}/${workerEntry} --host=127.0.0.1 --port=8052 --engine-path=${options['engine-path']}`,
        cwd: runtime
      },
      media: {
        start: `/usr/bin/env MEDIA_RESOLVER_PORT=8787 F2_PYTHON=${options['f2-python']} PATH=${dirname(options['yt-dlp'])}:${dirname(options.ffmpeg)}:/usr/local/bin:/usr/bin:/bin ${options['media-python']} -B ${options['release-dir']}/${mediaEntry} --host=127.0.0.1 --port=8787 --f2-bridge=${options['release-dir']}/${bridgeEntry}`,
        pre: `${options['media-python']} -B ${options['release-dir']}/${mediaEntry} --check --host=127.0.0.1 --port=8787 --f2-bridge=${options['release-dir']}/${bridgeEntry}`,
        cwd: runtime
      }
    };
    const spec = specsForRole[service];
    const dependencies = (spec.after ?? []).map(unitName).join(' ');
    const forbidden = services
      .filter((other) => other !== service)
      .flatMap((other) => [
        `-${options['state-dir']}/${other}`,
        `-${options['runtime-dir']}/${other}`,
        `-${options['private-config-dir']}/${other}`
      ])
      .join(' ');
    files[`systemd/${unitName(service)}`] =
      `[Unit]\nDescription=ID business V2 native ${service}\nAfter=network-online.target ${dependencies}\nWants=network-online.target\n${dependencies ? `Requires=${dependencies}\n` : ''}\n[Service]\nType=simple\nUser=${userName(service)}\nGroup=${userName(service)}\nWorkingDirectory=${spec.cwd}\nEnvironmentFile=${environmentFile}\nEnvironment=HOME=${temporaryRoot} TMPDIR=${temporaryRoot} PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1\n${['recharge', 'registration'].includes(service) ? `Environment=PLAYWRIGHT_BROWSERS_PATH=${state}/browser-cache\n` : ''}StateDirectory=${basename(options['state-dir'])}/${service}\nStateDirectoryMode=0700\nRuntimeDirectory=${basename(options['runtime-dir'])}/${service}\nRuntimeDirectoryMode=0700\nUMask=0077\nProtectSystem=strict\nProtectHome=true\nPrivateTmp=${temporarySize ? 'false' : 'true'}\n${temporaryFilesystems}NoNewPrivileges=true\nReadOnlyPaths=${options['release-dir']} ${options['config-dir']}${temporarySize ? ` ${runtime}` : ''}\nReadWritePaths=${state}${temporarySize ? '' : ` ${runtime}`}\nInaccessiblePaths=${forbidden}\n${service === 'caddy' ? 'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n' : 'CapabilityBoundingSet=\n'}${['recharge', 'registration'].includes(service) ? 'MemoryMax=1G\nMemorySwapMax=512M\nTasksMax=512\n' : ''}${service === 'media' ? 'MemoryMax=768M\nTasksMax=128\n' : ''}${spec.pre ? `ExecStartPre=${spec.pre}\n` : ''}ExecStart=${spec.start}\nExecStartPost=${health}\nRestart=on-failure\nRestartSec=5s\nKillMode=control-group\nKillSignal=SIGTERM\nTimeoutStartSec=60s\nTimeoutStopSec=45s\n\n[Install]\nWantedBy=multi-user.target\n`;
    specs[service] = {
      user: userName(service),
      port: ports[service],
      ...(service === 'caddy' ? { adminSocket: caddyAdminSocket(options['runtime-dir']) } : {}),
      state,
      runtime,
      ...(temporarySize
        ? {
            temporaryStorage: {
              directory: temporaryRoot,
              maxBytes: temporarySize * 1024 * 1024,
              sharedMemoryMaxBytes: 256 * 1024 * 1024,
              varTmpReadOnly: true,
              runtimeReadOnly: true,
              linuxRuntime: 'NOT_MEASURED'
            }
          }
        : {}),
      environmentFile,
      start: spec.start,
      health
    };
  }
  const manifest = {
    status: 'GENERATED_NOT_INSTALLED',
    linuxRuntime: 'NOT_MEASURED',
    productionChanged: false,
    secretsCopied: false,
    artifactIdentity: 'UNSEALED_NOT_ADMITTED',
    directoriesCreatedOutsideOutput: false,
    options,
    sourceContracts: {
      compose: sha(composeSource),
      nginx: sha(nginxSource),
      caddy: sha(caddySource)
    },
    services: specs,
    requiredBeforeEnable: [
      'Seven distinct non-root users and private environment files',
      'Approved immutable release and installed locked dependencies',
      'Independent approved artifact seal and checksum readback; path checks do not prove a release version',
      'Restored independent MySQL data and health client configuration',
      'Restored Caddy certificate/account storage',
      'Linux unit syntax, resource, network and browser isolation acceptance',
      'Linux Caddy socket ownership, private directory and denial from the other six service users',
      'Approved production baseline, finance checks and rollback'
    ],
    files: Object.fromEntries(
      Object.entries(files).map(([path, contents]) => [path, sha(contents)])
    )
  };
  files['native-manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`;
  return { files, manifest };
}

export function checkInstalledNativeServices(
  options,
  {
    platform = process.platform,
    stat = lstatSync,
    executableStat = statSync,
    realPath = realpathSync,
    userId = (user) => {
      const result = spawnSync('/usr/bin/id', ['-u', user], {
        encoding: 'utf8',
        timeout: 3000,
        shell: false
      });
      if (result.error || result.status !== 0 || !/^\d+\s*$/.test(result.stdout)) throw new Error();
      return Number(result.stdout.trim());
    }
  } = {}
) {
  if (platform !== 'linux') return { ok: false, reason: 'Linux systemd 实际安装预检尚未执行' };
  try {
    const selected = options.service ? [options.service] : services;
    const ids = services.map((service) => userId(userName(service)));
    if (
      ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(ids).size !== services.length
    )
      throw new Error();
    function immutableParents(path) {
      let parent = dirname(path);
      while (true) {
        const item = stat(parent);
        if (
          realPath(parent) !== resolve(parent) ||
          !item.isDirectory() ||
          item.isSymbolicLink() ||
          item.mode & 0o022 ||
          item.uid !== 0
        )
          throw new Error();
        if (parent === '/') break;
        parent = dirname(parent);
      }
    }
    for (const name of [
      'release-dir',
      'config-dir',
      'private-config-dir',
      'state-dir',
      'runtime-dir'
    ]) {
      if (realPath(options[name]) !== resolve(options[name])) throw new Error();
    }
    for (const name of ['release-dir', 'config-dir', 'private-config-dir']) {
      const item = stat(options[name]);
      if (
        !item.isDirectory() ||
        item.isSymbolicLink() ||
        item.mode & 0o022 ||
        !(item.mode & 0o001) ||
        item.uid !== 0
      )
        throw new Error();
    }
    for (const binary of [
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
    ]) {
      // venv 的 Python 链接保留虚拟环境身份；核对其实际可执行文件而非拒绝合法链接。
      const item = executableStat(options[binary]);
      if (!item.isFile() || !(item.mode & 0o001) || item.mode & 0o022 || item.uid !== 0)
        throw new Error();
      immutableParents(options[binary]);
      immutableParents(realPath(options[binary]));
    }
    for (const path of [
      options['nginx-mime-types'],
      `${options['config-dir']}/nginx.conf`,
      `${options['config-dir']}/Caddyfile`,
      `${options['config-dir']}/mysql.cnf`,
      `${options['release-dir']}/apps/api/dist/main.js`,
      `${options['release-dir']}/apps/admin/dist/index.html`,
      `${options['release-dir']}/${workerEntry}`,
      `${options['release-dir']}/${mediaEntry}`,
      `${options['release-dir']}/${bridgeEntry}`,
      `${options['release-dir']}/scripts/native-services.mjs`
    ]) {
      const item = stat(path);
      if (!item.isFile() || item.isSymbolicLink() || item.mode & 0o022 || !(item.mode & 0o004))
        throw new Error();
    }
    for (const service of selected) {
      if (
        realPath(`${options['private-config-dir']}/${service}`) !==
        resolve(options['private-config-dir'], service)
      )
        throw new Error();
      const directory = stat(`${options['private-config-dir']}/${service}`);
      const env = stat(`${options['private-config-dir']}/${service}/service.env`);
      const uid = ids[services.indexOf(service)];
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        directory.mode & 0o077 ||
        ![0, uid].includes(directory.uid) ||
        !env.isFile() ||
        env.isSymbolicLink() ||
        env.mode & 0o077 ||
        ![0, uid].includes(env.uid)
      )
        throw new Error();
      if (service === 'mysql') {
        const data = stat(`${options['state-dir']}/mysql/data`);
        const health = stat(`${options['private-config-dir']}/mysql/health.cnf`);
        if (
          !data.isDirectory() ||
          data.isSymbolicLink() ||
          data.mode & 0o077 ||
          data.uid !== uid ||
          directory.uid !== uid ||
          !health.isFile() ||
          health.isSymbolicLink() ||
          health.mode & 0o077 ||
          health.uid !== uid
        )
          throw new Error();
      } else if (service === 'caddy') {
        const storage = stat(`${options['state-dir']}/caddy/storage`);
        if (
          !storage.isDirectory() ||
          storage.isSymbolicLink() ||
          storage.mode & 0o077 ||
          storage.uid !== uid
        )
          throw new Error();
      }
    }
    return {
      ok: true,
      artifactIdentity: 'UNSEALED_NOT_ADMITTED',
      reason: '安装路径与私有配置权限通过；制品身份尚未独立封存，Linux 运行与业务尚未验收'
    };
  } catch {
    return {
      ok: false,
      reason: '安装预检失败：缺少独立非 root 账号、已安装制品或受保护的私有配置'
    };
  }
}

export function writeNativeServiceBundle(bundle, outputDir, { root = projectDir } = {}) {
  const output = resolve(outputDir);
  const runtimeRoot = resolve(root, '.runtime');
  if (!beneath(runtimeRoot, output)) throw new Error('输出必须属于本项目 .runtime 内的独立目录');
  let parent = output;
  while (parent !== root) {
    try {
      if (lstatSync(parent).isSymbolicLink()) throw new Error('输出路径不能经过软链接');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    parent = dirname(parent);
  }
  try {
    lstatSync(output);
    throw new Error('输出目录已存在，不覆盖已有候选');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const path of Object.keys(bundle.files)) {
    if (
      path !== 'native-manifest.json' &&
      !/^(?:nginx\.conf|Caddyfile|mysql\.cnf|systemd\/id-business-v2-[a-z]+\.service)$/.test(path)
    )
      throw new Error('候选文件范围无效');
  }
  mkdirSync(output, { recursive: true, mode: 0o700 });
  mkdirSync(resolve(output, 'systemd'), { mode: 0o700 });
  for (const [path, contents] of Object.entries(bundle.files)) {
    writeFileSync(resolve(output, path), contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  return output;
}

export async function nativeServiceHealth(
  service,
  {
    environment = process.env,
    fetcher = fetch,
    run = spawnSync,
    mysql,
    privateConfigDir,
    runtimeDir,
    socketRequest = request,
    stat = lstatSync,
    realPath = realpathSync,
    userId = () => process.getuid?.()
  } = {}
) {
  if (!services.includes(service)) return false;
  if (service === 'caddy') {
    try {
      const socketPath = caddyAdminSocket(runtimeDir);
      const directory = dirname(socketPath);
      const uid = userId();
      if (!Number.isInteger(uid) || uid <= 0) return false;
      for (const path of [runtimeDir, directory, socketPath]) {
        if (realPath(path) !== path || stat(path).isSymbolicLink()) return false;
      }
      const runtime = stat(runtimeDir);
      const privateDirectory = stat(directory);
      const socket = stat(socketPath);
      if (
        !runtime.isDirectory() ||
        runtime.uid !== 0 ||
        runtime.mode & 0o022 ||
        !privateDirectory.isDirectory() ||
        privateDirectory.uid !== uid ||
        (privateDirectory.mode & 0o777) !== 0o700 ||
        !socket.isSocket() ||
        socket.uid !== uid ||
        socket.mode & 0o077
      )
        return false;
      return await new Promise((done) => {
        const client = socketRequest(
          {
            socketPath,
            method: 'GET',
            path: '/config/',
            headers: { Host: 'localhost' },
            agent: false,
            signal: AbortSignal.timeout(3000)
          },
          (response) => {
            response.on('error', () => done(false));
            response.on('aborted', () => done(false));
            response.on('end', () => done(response.statusCode === 200));
            response.resume();
          }
        );
        client.on('error', () => done(false));
        client.end();
      });
    } catch {
      return false;
    }
  }
  if (service === 'mysql') {
    try {
      targetPath(mysql);
      targetPath(privateConfigDir);
      const result = run(
        mysql,
        [
          `--defaults-extra-file=${privateConfigDir}/mysql/health.cnf`,
          '--no-login-paths',
          '--host=127.0.0.1',
          '--port=3306',
          '--protocol=TCP',
          '--batch',
          '--skip-column-names',
          '--execute=SELECT 1'
        ],
        { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false }
      );
      return !result.error && result.status === 0 && result.stdout?.trim() === '1';
    } catch {
      return false;
    }
  }
  const token = environment.AUTO_RECHARGE_WORKER_TOKEN ?? '';
  if (['recharge', 'registration'].includes(service) && token.length < 32) return false;
  try {
    const path = {
      api: '/api/health/ready',
      admin: '/',
      recharge: '/health',
      registration: '/registration/health',
      media: '/health'
    }[service];
    const headers = service === 'registration' ? { 'X-Recharge-Worker': token } : {};
    const response = await fetcher(`http://127.0.0.1:${ports[service]}${path}`, {
      headers,
      signal: AbortSignal.timeout(3000),
      redirect: 'error'
    });
    if (!response.ok) return false;
    if (['recharge', 'registration'].includes(service)) {
      const body = await response.json();
      if (
        body.workerRole !== service ||
        (service === 'registration' ? body.ready !== true : body.ok !== true)
      )
        return false;
      if (service === 'recharge') {
        const authorized = await fetcher(
          'http://127.0.0.1:8051/jobs/00000000-0000-0000-0000-000000000000/status',
          {
            headers: { 'X-Recharge-Worker': token },
            signal: AbortSignal.timeout(3000),
            redirect: 'error'
          }
        );
        await authorized.body?.cancel();
        return authorized.status === 404 || authorized.status === 200;
      }
    } else await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

export async function nativeServicesMain(
  argv,
  {
    log = console.log,
    installedCheck = checkInstalledNativeServices,
    write = writeNativeServiceBundle,
    health = nativeServiceHealth
  } = {}
) {
  try {
    const options = parseNativeServicesOptions(argv);
    if (options.help) {
      log(
        `原生服务默认仅结构预检，不安装或启动。须明确提供：${pathNames.map((name) => `--${name}=绝对路径`).join(' ')}；显式 --write --output-dir=本项目/.runtime/独立候选目录 生成；--installed-check 仅核对已安装 Linux 路径；--health=服务 仅检查本机服务；Caddy 健康检查须带 --runtime-dir=/run/独立运行目录，并由 Caddy 服务账号执行。`
      );
      return 0;
    }
    if (options.health) {
      const deadline = Date.now() + options.wait * 1000;
      do {
        if (
          await health(options.health, {
            mysql: options.mysql,
            privateConfigDir: options['private-config-dir'],
            runtimeDir: options['runtime-dir']
          })
        ) {
          log('原生服务健康检查通过');
          return 0;
        }
        if (Date.now() >= deadline) break;
        await new Promise((done) => setTimeout(done, 1000));
      } while (Date.now() < deadline);
      log('原生服务健康检查失败；详情不含凭据');
      return 1;
    }
    const bundle = nativeServiceBundle(options);
    if (options['installed-check']) {
      const result = installedCheck(options);
      log(result.reason);
      return result.ok ? 0 : 1;
    }
    if (options.write) write(bundle, options['output-dir']);
    log(
      options.write
        ? '七服务候选配置已生成；未安装、未启动，Linux 运行尚未验证'
        : '七服务配置结构预检通过；未写文件、未读取私有配置，Linux 运行尚未验证'
    );
    return 0;
  } catch {
    log('原生服务准备失败：请检查明确路径、参数、配置契约和隔离输出目录');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await nativeServicesMain(process.argv.slice(2));
}
