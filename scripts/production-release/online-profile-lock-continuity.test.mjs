// Real browser, synthetic state, no Docker/production/external network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../apps/api/src/id-business-v2/online-recharge/engine/upstream/node_modules/playwright/index.mjs';
const directoryName = fileURLToPath(new URL('.', import.meta.url));
const output = path.resolve(directoryName, '../../.runtime/profile-lock-recovery-20261025/native');
const names = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

async function files(directory, prefix = '') {
  const result = {};
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    if (names.includes(item.name) || item.name === '.retired-singletons') continue;
    const absolute = path.join(directory, item.name);
    const relative = prefix + item.name;
    if (item.isDirectory()) Object.assign(result, await files(absolute, relative + '/'));
    else if (item.isFile())
      result[relative] = crypto
        .createHash('sha256')
        .update(await fs.readFile(absolute))
        .digest('hex');
  }
  return result;
}

async function launch(directory) {
  const context = await chromium.launchPersistentContext(directory, {
    channel: 'chromium',
    headless: true,
    timeout: 15000,
    args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND']
  });
  await context.route('**/*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body>synthetic offline page</body></html>'
    })
  );
  return context;
}

test(
  'archiving retired singleton links preserves native HttpOnly cookies and local storage',
  { timeout: 45000 },
  async () => {
    await fs.mkdir(output, { recursive: true });
    const directory = await fs.mkdtemp(path.join(output, 'state-'));
    let context;
    try {
      context = await launch(directory);
      const page = context.pages()[0];
      await page.goto('https://fixture.invalid/');
      await page.evaluate(() =>
        localStorage.setItem('synthetic-state', 'synthetic-preserved-value')
      );
      await context.addCookies([
        {
          name: 'synthetic-session',
          value: 'synthetic-preserved-cookie',
          url: 'https://fixture.invalid/',
          httpOnly: true,
          secure: true,
          expires: Math.floor(Date.now() / 1000) + 3600
        }
      ]);
      await assert.rejects(launch(directory), /ProcessSingleton|profile.*in use|SingletonLock/i);
      assert.equal(
        context.browser().isConnected(),
        true,
        'native concurrency guard still owns the browser'
      );
      await context.close();
      context = null;
      for (const name of names) await fs.rm(path.join(directory, name), { force: true });
      await fs.symlink('012345abcdef-2426', path.join(directory, names[0]));
      await fs.symlink('synthetic-native-cookie', path.join(directory, names[1]));
      await fs.symlink(
        '/tmp/retired-synthetic-container/SingletonSocket',
        path.join(directory, names[2])
      );
      // Linux rejects a foreign-host singleton; macOS has different native semantics.
      // Do not claim to reproduce the production Linux refusal from a Mac run.
      if (process.platform === 'linux')
        await assert.rejects(launch(directory), /ProcessSingleton|profile.*in use|SingletonLock/i);
      const before = await files(directory);
      const script = `
import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('offline_recovery',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
fd=os.open(sys.argv[2],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try: print(json.dumps({'archived':module.quarantine(fd,module.entries(fd))}))
finally: os.close(fd)
`;
      const { stdout } = await promisify(execFile)(
        'python3',
        [
          '-B',
          '-c',
          script,
          path.join(directoryName, 'online-profile-lock-recovery.py'),
          directory
        ],
        { timeout: 10000 }
      );
      assert.deepEqual(JSON.parse(stdout), { archived: 3 });
      assert.deepEqual(
        await files(directory),
        before,
        'every native data file remains byte-for-byte identical during recovery'
      );
      context = await launch(directory);
      const cookie = (await context.cookies('https://fixture.invalid/')).find(
        (item) => item.name === 'synthetic-session'
      );
      assert.equal(cookie?.httpOnly, true);
      assert.equal(cookie?.value, 'synthetic-preserved-cookie');
      const resumed = context.pages()[0];
      await resumed.goto('https://fixture.invalid/');
      assert.equal(
        await resumed.evaluate(() => localStorage.getItem('synthetic-state')),
        'synthetic-preserved-value'
      );
    } finally {
      await context?.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
);
