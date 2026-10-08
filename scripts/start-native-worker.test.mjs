import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nativeWorkerLaunch,
  parseNativeWorkerOptions,
  startNativeWorker
} from './start-native-worker.mjs';

const token = 'synthetic-worker-secret-32-characters';
const args = [
  '--python=fixture-python',
  '--engine-path=/fixture/Camoufox.app/Contents/MacOS/camoufox'
];

test('两个角色使用不同默认端口和运行目录，凭据仅由环境传递', () => {
  const recharge = nativeWorkerLaunch(parseNativeWorkerOptions(args), {
    AUTO_RECHARGE_WORKER_TOKEN: token,
    UNRELATED_SECRET: 'do-not-pass',
    PATH: '/fixture/bin'
  });
  const registration = nativeWorkerLaunch(
    parseNativeWorkerOptions([...args, '--role=registration']),
    {
      AUTO_RECHARGE_WORKER_TOKEN: token
    }
  );
  assert.equal(recharge.args[recharge.args.indexOf('--port') + 1], '8051');
  assert.equal(registration.args[registration.args.indexOf('--port') + 1], '8052');
  assert.notEqual(recharge.cwd, registration.cwd);
  assert.equal(recharge.env.AUTO_RECHARGE_WORKER_TOKEN, token);
  assert.equal(registration.env.AUTO_RECHARGE_WORKER_ROLE, 'registration');
  assert.equal(recharge.env.UNRELATED_SECRET, undefined);
  assert.equal(recharge.args.includes(token), false);
  assert.equal(
    recharge.env.AUTO_RECHARGE_CALLBACK_URL,
    'http://127.0.0.1:3000/api/id-business-v2/auto-recharge/internal'
  );
});

test('无效、重复和公开监听参数在执行前停止', () => {
  for (const extra of [
    ['--role=unknown'],
    ['--host=0.0.0.0'],
    ['--port=0'],
    ['--port=65536'],
    ['--port=5e3'],
    ['--password=private'],
    ['--port=8051', '--port=8052'],
    ['--port']
  ])
    assert.throws(() => parseNativeWorkerOptions([...args, ...extra]));
  assert.throws(() => parseNativeWorkerOptions(['--python=python', '--engine-path=relative']));
});

test('缺少授权或远程/含凭据的回调地址不能启动本机 Worker', () => {
  const options = parseNativeWorkerOptions(args);
  assert.throws(() => nativeWorkerLaunch(options, {}));
  for (const callback of [
    'https://example.com/api/id-business-v2/auto-recharge/internal',
    'http://private:secret@127.0.0.1:3000/api/id-business-v2/auto-recharge/internal',
    'http://127.0.0.1:3000/other',
    'http://127.0.0.1:3000/api/id-business-v2/auto-recharge/internal?token=private'
  ])
    assert.throws(() =>
      nativeWorkerLaunch(options, {
        AUTO_RECHARGE_WORKER_TOKEN: token,
        AUTO_RECHARGE_CALLBACK_URL: callback
      })
    );
});

function fixture(extra = {}) {
  const output = [];
  const commands = [];
  const dependencies = {
    environment: { AUTO_RECHARGE_WORKER_TOKEN: token },
    log: (line) => output.push(line),
    checkEngine: () => {},
    run: (command, argv) => {
      commands.push({ command, argv });
      return { status: 0 };
    },
    launchWorker: () => {
      throw new Error('unexpected service launch');
    },
    makeRuntimeDir: () => {
      throw new Error('unexpected file write');
    },
    ...extra
  };
  return { output, commands, dependencies };
}

test('原生预检不调用 Docker、启动服务、写目录或输出凭据', async () => {
  const f = fixture();
  assert.equal(await startNativeWorker([...args, '--check'], f.dependencies), 0);
  assert.equal(f.commands.length, 2);
  assert.ok(f.commands.every(({ command }) => command === 'fixture-python'));
  assert.equal(f.output.join('\n').includes(token), false);
});

test('Python 或依赖不完整时停止，原始错误不进入输出', async () => {
  for (const result of [
    { status: 1, stderr: 'private-token' },
    { error: new Error('private-token') }
  ]) {
    const f = fixture({ run: () => result });
    assert.equal(await startNativeWorker(args, f.dependencies), 1);
    assert.equal(f.output.join('\n').includes('private-token'), false);
  }
});

test('缺失内核先停止，不检查依赖，也不泄露底层异常', async () => {
  const f = fixture({
    checkEngine: () => {
      throw new Error('private-engine-detail');
    }
  });
  assert.equal(await startNativeWorker(args, f.dependencies), 1);
  assert.equal(f.commands.length, 0);
  assert.equal(f.output.join('\n').includes('private-engine-detail'), false);
});

test('实际启动仅创建当前角色目录，并调用已有 Python/Worker', async () => {
  const directories = [];
  let launch;
  const f = fixture({
    makeRuntimeDir: (path, options) => directories.push({ path, options }),
    launchWorker: (value) => {
      launch = value;
      return 0;
    }
  });
  assert.equal(
    await startNativeWorker([...args, '--role=registration', '--port=18052'], f.dependencies),
    0
  );
  assert.equal(directories.length, 1);
  assert.equal(directories[0].options.mode, 0o700);
  assert.equal(directories[0].path, launch.cwd);
  assert.equal(launch.command, 'fixture-python');
  assert.ok(launch.args.includes('18052'));
  assert.ok(launch.args[1].endsWith('/worker/server.py'));
  assert.equal(f.output.join('\n').includes(token), false);
});
