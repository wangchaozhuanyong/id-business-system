import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

function fixture(run) {
  mkdirSync('.deploy', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.deploy/release-scope-test-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'docker.log');
  writeFileSync(log, '');
  writeFileSync(join(bin, 'git'), '#!/bin/sh\ncat "$TASK_CHANGED_PATHS"\n', { mode: 0o755 });
  writeFileSync(
    join(bin, 'docker'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TASK_DOCKER_LOG"\nif [ "$1" = login ]; then cat >/dev/null; fi\nif [ "$1" = image ]; then printf "%s\\n" "$RELEASE_COMMIT"; fi\n',
    { mode: 0o755 }
  );
  writeFileSync(
    join(bin, 'aws'),
    '#!/bin/sh\ncase "$*" in\n*get-login-password*) printf "test-fixture-only\\n" ;;\n*describe-images*) printf "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n" ;;\nesac\n',
    { mode: 0o755 }
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    EXPECTED_CURRENT: 'a'.repeat(40),
    RELEASE_COMMIT: 'b'.repeat(40),
    RELEASE_REPOSITORY: '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release',
    GITHUB_RUN_ID: '999999',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_ENV: join(root, 'github.env'),
    TASK_CHANGED_PATHS: join(root, 'changed.txt'),
    TASK_DOCKER_LOG: log,
    AWS_REGION: 'ap-northeast-1'
  };
  try {
    run({ root, env, log });
  } finally {
    rmSync(root, { recursive: true });
  }
}

test('real build and push scripts select only admin for frontend plus release-control changes', () => {
  fixture(({ env, log }) => {
    writeFileSync(
      env.TASK_CHANGED_PATHS,
      [
        'apps/admin/src/v2/components/workspace/V2QuickActions.vue',
        'scripts/production-release/build-images.sh',
        'scripts/production-release/remote-deploy.py',
        'docs/V2_TASKS.md'
      ].join('\n')
    );
    execFileSync('bash', ['scripts/production-release/build-images.sh'], { env });
    assert.equal(readFileSync(env.GITHUB_ENV, 'utf8'), 'RELEASE_ADMIN_ONLY=true\n');
    const built = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('build '));
    assert.equal(built.length, 1);
    assert.ok(built[0].includes('apps/admin/Dockerfile'));
    execFileSync('bash', ['scripts/production-release/push-images.sh'], {
      env: { ...env, RELEASE_ADMIN_ONLY: 'true' }
    });
    const pushed = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('push '));
    assert.equal(pushed.length, 1);
    assert.ok(pushed[0].endsWith('-admin'));
  });
});

test('dependency, API, shared, schema and authentication changes retain all image builds', () => {
  for (const path of [
    'package-lock.json',
    'apps/api/src/id-business-v2/orders/service.ts',
    'packages/shared/src/index.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/admin/src/auth/login.ts'
  ]) {
    fixture(({ env, log }) => {
      writeFileSync(env.TASK_CHANGED_PATHS, path);
      execFileSync('bash', ['scripts/production-release/build-images.sh'], { env });
      assert.equal(readFileSync(env.GITHUB_ENV, 'utf8'), 'RELEASE_ADMIN_ONLY=false\n');
      assert.equal(
        readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith('build ')).length,
        5
      );
    });
  }
});

test('full push mode retains all five images and rejects an unknown scope flag', () => {
  fixture(({ env, log }) => {
    execFileSync('bash', ['scripts/production-release/push-images.sh'], { env });
    assert.equal(
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('push ')).length,
      5
    );
    assert.throws(() =>
      execFileSync('bash', ['scripts/production-release/push-images.sh'], {
        env: { ...env, RELEASE_ADMIN_ONLY: 'unexpected' },
        stdio: 'pipe'
      })
    );
  });
});

test('recovery dispatch keeps deployment run and reused image run separate', () => {
  fixture(({ root, env }) => {
    writeFileSync(
      join(root, 'bin', 'aws'),
      '#!/bin/sh\ncase "$*" in\n*send-command*) printf "fixture-command\\n" ;;\n*--query\\ Status*) printf "Success\\n" ;;\n*StandardOutputContent*) printf "fixture-receipt\\n" ;;\nesac\n',
      { mode: 0o755 }
    );
    execFileSync('bash', [join(process.cwd(), 'scripts/production-release/dispatch.sh')], {
      cwd: root,
      env: {
        ...env,
        SOURCE_TREE: 'c'.repeat(40),
        QUALITY_RUN_ID: '111',
        PRODUCTION_INSTANCE_ID: 'i-test-fixture-only',
        REUSE_IMAGE_COMMIT: 'd'.repeat(40),
        REUSE_IMAGE_RUN_ID: '222',
        REUSE_IMAGE_RUN_ATTEMPT: '1'
      }
    });
    const parameters = JSON.parse(
      readFileSync(join(root, '.deploy/production-release/ssm-999999.json'), 'utf8')
    );
    const command = parameters.commands.at(-1);
    assert.ok(command.includes(`--commit ${'b'.repeat(40)}`));
    assert.ok(command.includes('--run-id 999999'));
    assert.ok(command.includes(`--image-commit ${'d'.repeat(40)}`));
    assert.ok(command.includes('--image-run-id 222 --image-run-attempt 1'));
  });
});
