'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { runInNewContext } = require('node:vm');
const { observeSessionRequests, responseReadMetadata } = require('../subscription-diagnostics.cjs');
const { observeSessionConnections } = require('../session-connection-diagnostics.cjs');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const secret = 'synthetic-private-cookie-and-query';
const url = 'https://chatgpt.com/api/auth/session?secret=' + secret;
function fixture() {
  const context = new EventEmitter(),
    page = new EventEmitter(),
    cdp = new EventEmitter();
  const events = [],
    commands = [];
  let detachCount = 0;
  cdp.send = async (method) => {
    commands.push(method);
  };
  cdp.detach = async () => {
    detachCount++;
  };
  context.pages = () => [page];
  context.newCDPSession = async () => cdp;
  context.newPage =
    context.addCookies =
    context.route =
      () => {
        throw Error('MUTATION');
      };
  context.request = {
    get: () => {
      throw Error('HTTP_NOT_ALLOWED');
    }
  };
  return { context, page, cdp, events, commands, detached: () => detachCount };
}
function request(f, id = 'raw-id-' + secret, type = 'Document', rawUrl = url) {
  f.cdp.emit('Network.requestWillBeSent', {
    requestId: id,
    type,
    request: { url: rawUrl, headers: { Cookie: secret } }
  });
}
function response(f, id = 'raw-id-' + secret, overrides = {}) {
  f.cdp.emit('Network.responseReceived', {
    requestId: id,
    response: {
      url,
      status: 200,
      connectionId: 42,
      connectionReused: false,
      remoteIPAddress: '203.0.113.7',
      headers: { server: 'cloudflare', 'content-type': 'application/json', 'set-cookie': secret },
      ...overrides
    }
  });
}
test('CDP correlates document/fetch and connection reuse with safe fields, without new HTTP requests', async () => {
  const f = fixture();
  const observer = observeSessionConnections(
    f.context,
    (x) => f.events.push(x),
    responseReadMetadata
  );
  await flush();
  request(f);
  response(f);
  f.cdp.emit('Network.loadingFinished', { requestId: 'raw-id-' + secret });
  request(f, 'second', 'Fetch');
  response(f, 'second', {
    status: 403,
    connectionReused: true,
    headers: { 'cf-mitigated': 'challenge', server: 'cloudflare' }
  });
  const rows = f.events.filter((x) => x.event === 'connection_response');
  assert.deepEqual(
    rows.map((x) => [x.requestId, x.httpStatus, x.connectionId, x.connectionReused]),
    [
      [1, 200, 42, false],
      [2, 403, 42, true]
    ]
  );
  assert.equal(rows[1].cfMitigated, 'challenge');
  assert.equal(rows[0].remoteAddressRole, 'remote_peer_not_client_exit');
  assert.equal(rows[0].remoteAddressHash, createHash('sha256').update('203.0.113.7').digest('hex'));
  assert.deepEqual(f.commands, ['Network.enable']);
  assert.ok(!JSON.stringify(f.events).includes(secret));
  assert.ok(!JSON.stringify(f.events).includes('203.0.113.7'));
  observer.dispose();
  assert.equal(f.detached(), 1);
});
test('redirect hops share an ordinal only on the same page; unrelated targets and responses are ignored', async () => {
  const f = fixture();
  const observer = observeSessionConnections(
    f.context,
    (x) => f.events.push(x),
    responseReadMetadata
  );
  await flush();
  request(f);
  response(f, undefined, { status: 302 });
  request(f);
  response(f);
  assert.deepEqual(
    f.events
      .filter((x) => x.event === 'connection_request')
      .map((x) => [x.requestId, x.redirectHop]),
    [
      [1, 0],
      [1, 1]
    ]
  );
  request(f, undefined, 'Document', 'https://example.invalid/api/auth/session');
  response(f);
  assert.equal(f.events.filter((x) => x.event === 'connection_response').length, 2);
  observer.dispose();
});
test('new pages attach independently, page close releases listeners and identical CDP IDs are not conflated', async () => {
  const f = fixture(),
    second = new EventEmitter(),
    cdp2 = new EventEmitter();
  cdp2.send = async () => {};
  cdp2.detach = async () => {};
  f.context.newCDPSession = async (p) => (p === second ? cdp2 : f.cdp);
  const observer = observeSessionRequests(f.context, (x) => f.events.push(x));
  await flush();
  f.context.emit('page', second);
  await flush();
  request(f);
  request({ cdp: cdp2 });
  response(f);
  response({ cdp: cdp2 });
  assert.deepEqual(
    f.events.filter((x) => x.event === 'connection_response').map((x) => x.pageSequence),
    [1, 2]
  );
  second.emit('close');
  for (const event of [
    'Network.requestWillBeSent',
    'Network.responseReceived',
    'Network.loadingFinished',
    'Network.loadingFailed'
  ])
    assert.equal(cdp2.listenerCount(event), 0);
  observer.dispose();
  assert.equal(f.context.listenerCount('page'), 0);
  assert.equal(f.context.listenerCount('request'), 0);
});
test('attach/enable/logging failures never throw or change existing request observations', async () => {
  const f = fixture();
  f.cdp.send = async () => {
    throw Error(secret);
  };
  const observer = observeSessionRequests(f.context, (x) => f.events.push(x));
  await flush();
  assert.equal(f.events.find((x) => x.event === 'connection_observer').complete, false);
  assert.equal(f.detached(), 1);
  const req = {
    url: () => url,
    resourceType: () => 'fetch',
    method: () => 'GET',
    allHeaders: async () => ({})
  };
  assert.doesNotThrow(() => f.context.emit('request', req));
  await flush();
  assert.equal(f.events.find((x) => x.event === 'request').resourceType, 'fetch');
  assert.ok(!JSON.stringify(f.events).includes(secret));
  observer.dispose();
  const g = fixture();
  const logs = observeSessionConnections(
    g.context,
    () => {
      throw Error(secret);
    },
    responseReadMetadata
  );
  await flush();
  assert.doesNotThrow(() => {
    request(g);
    response(g);
  });
  logs.dispose();
});
test('context close before delayed CDP attach suppresses late events and detaches its own session', async () => {
  const f = fixture();
  let release;
  f.context.newCDPSession = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const observer = observeSessionConnections(
    f.context,
    (x) => f.events.push(x),
    responseReadMetadata
  );
  await flush();
  f.context.emit('close');
  release(f.cdp);
  await flush();
  assert.equal(f.detached(), 1);
  assert.deepEqual(f.commands, []);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].setupFailure, 'context_closed');
  assert.equal(f.events[0].setupOperation, 'new_cdp_session');
  observer.dispose();
});
test('stalled diagnostic enable times out independently and does not wait on login', async () => {
  const f = fixture();
  let finishEnable;
  f.cdp.send = () =>
    new Promise((resolve) => {
      finishEnable = resolve;
    });
  const observer = observeSessionConnections(
    f.context,
    (x) => f.events.push(x),
    responseReadMetadata
  );
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const failure = f.events.at(-1);
  assert.equal(failure.reason, 'setup_incomplete');
  assert.equal(failure.setupOperation, 'network_enable');
  assert.equal(failure.setupFailure, 'deadline');
  assert.equal(failure.setupBudgetMs, 1000);
  assert.equal(failure.errorName, 'none');
  assert.equal(failure.errorClass, 'none');
  assert.ok(Number.isSafeInteger(failure.setupElapsedMs));
  assert.ok(failure.setupElapsedMs >= failure.operationElapsedMs);
  assert.ok(failure.operationElapsedMs >= 0);
  assert.equal(f.detached(), 1);
  finishEnable();
  await flush();
  request(f);
  response(f);
  assert.equal(f.events.length, 1);
  assert.equal(f.detached(), 1);
  observer.dispose();
});

test('setup schedules exactly 1000ms and preserves measured elapsed time independently of timer precision', async () => {
  const f = fixture();
  let finishAttach, timer;
  let now = 100;
  f.context.newCDPSession = () =>
    new Promise((resolve) => {
      finishAttach = resolve;
    });
  const sandbox = {
    module: { exports: {} },
    require,
    performance: { now: () => now },
    setTimeout(callback, delay) {
      timer = { callback, delay, unref() {} };
      return timer;
    },
    clearTimeout() {}
  };
  runInNewContext(
    fs.readFileSync(require.resolve('../session-connection-diagnostics.cjs'), 'utf8'),
    sandbox
  );
  const observer = sandbox.module.exports.observeSessionConnections(
    f.context,
    (row) => f.events.push(row),
    responseReadMetadata
  );
  await flush();
  assert.equal(timer.delay, 1000);
  // Timer delivery and the diagnostic's monotonic elapsed measurement are
  // separate observations; the measured duration must never be fabricated.
  now = 1099.2;
  timer.callback();
  assert.equal(f.events[0].setupFailure, 'deadline');
  assert.equal(f.events[0].setupOperation, 'new_cdp_session');
  assert.equal(f.events[0].setupBudgetMs, 1000);
  assert.equal(f.events[0].setupElapsedMs, 999);
  assert.equal(f.events[0].operationElapsedMs, 999);
  finishAttach(f.cdp);
  await flush();
  assert.deepEqual(f.commands, []);
  assert.equal(f.detached(), 1);
  observer.dispose();
});

test('late attach retains the timed-out operation and detaches without starting Network.enable', async () => {
  const f = fixture();
  let finishAttach;
  let attachCalls = 0;
  f.context.newCDPSession = () => {
    attachCalls++;
    return new Promise((resolve) => {
      finishAttach = resolve;
    });
  };
  const observer = observeSessionConnections(
    f.context,
    (x) => f.events.push(x),
    responseReadMetadata
  );
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].setupOperation, 'new_cdp_session');
  assert.equal(f.events[0].setupFailure, 'deadline');
  assert.equal(f.events[0].setupBudgetMs, 1000);
  finishAttach(f.cdp);
  await flush();
  assert.equal(attachCalls, 1);
  assert.deepEqual(f.commands, []);
  assert.equal(f.detached(), 1);
  observer.dispose();
  assert.equal(f.events.length, 1);
});

test('attach and enable exceptions retain safe operation and error classes without credential text', async () => {
  for (const [operation, message, name, errorClass] of [
    [
      'new_cdp_session',
      'Target page, context or browser has been closed',
      'Error',
      'target_closed'
    ],
    ['network_enable', 'Timeout ' + secret, 'TimeoutError', 'timeout'],
    ['network_enable', 'Protocol error ' + secret, 'Error', 'protocol_error'],
    ['new_cdp_session', 'Execution context was destroyed ' + secret, 'Error', 'context_destroyed'],
    ['new_cdp_session', 'Connection closed ' + secret, 'Error', 'connection_closed'],
    ['new_cdp_session', 'Not supported ' + secret, 'Error', 'unsupported'],
    ['new_cdp_session', secret, secret, 'other']
  ]) {
    const f = fixture();
    const error = Object.assign(new Error(message), { name });
    if (operation === 'new_cdp_session')
      f.context.newCDPSession = async () => {
        throw error;
      };
    else
      f.cdp.send = async () => {
        throw error;
      };
    const observer = observeSessionConnections(
      f.context,
      (x) => f.events.push(x),
      responseReadMetadata
    );
    await flush();
    const row = f.events.at(-1);
    assert.equal(row.setupOperation, operation);
    assert.equal(row.setupFailure, 'exception');
    assert.equal(row.errorClass, errorClass);
    assert.equal(row.errorName, name === secret ? 'other' : name);
    assert.equal(row.setupBudgetMs, 1000);
    assert.ok(row.operationElapsedMs >= 0);
    assert.ok(row.setupElapsedMs >= row.operationElapsedMs);
    assert.equal(f.detached(), operation === 'new_cdp_session' ? 0 : 1);
    assert.ok(!JSON.stringify(f.events).includes(secret));
    observer.dispose();
  }
});

test('page and observer closure during setup are explicit and never produce a later ready event', async () => {
  for (const reason of ['page_closed', 'observer_disposed']) {
    const f = fixture();
    let finishEnable;
    f.cdp.send = () =>
      new Promise((resolve) => {
        finishEnable = resolve;
      });
    const observer = observeSessionConnections(
      f.context,
      (x) => f.events.push(x),
      responseReadMetadata
    );
    await flush();
    if (reason === 'page_closed') f.page.emit('close');
    else observer.dispose(secret);
    finishEnable();
    await flush();
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].setupOperation, 'network_enable');
    assert.equal(f.events[0].setupFailure, reason);
    assert.equal(f.detached(), 1);
    assert.equal(f.cdp.listenerCount('Network.responseReceived'), 0);
    assert.ok(!JSON.stringify(f.events).includes(secret));
    observer.dispose();
  }
});

test('registration, context enumeration and unsupported contexts identify their exact setup operation', async () => {
  for (const operation of [
    'page_listener',
    'register_network_listeners',
    'context_listeners',
    'enumerate_pages',
    'context_support'
  ]) {
    const f = fixture();
    const fail = () => {
      throw new TypeError(secret);
    };
    if (operation === 'page_listener') f.page.on = fail;
    if (operation === 'register_network_listeners') f.cdp.on = fail;
    if (operation === 'context_listeners') f.context.on = fail;
    if (operation === 'enumerate_pages') f.context.pages = fail;
    if (operation === 'context_support') f.context.newCDPSession = undefined;
    const observer = observeSessionConnections(
      f.context,
      (x) => f.events.push(x),
      responseReadMetadata
    );
    await flush();
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].setupOperation, operation);
    assert.equal(
      f.events[0].setupFailure,
      operation === 'context_support' ? 'unsupported' : 'exception'
    );
    assert.ok(!JSON.stringify(f.events).includes(secret));
    observer.dispose();
  }
});

test('unreadable error properties remain isolated from the original Session request observer', async () => {
  const f = fixture();
  f.context.newCDPSession = async () => {
    throw {
      get name() {
        throw Error(secret);
      }
    };
  };
  const observer = observeSessionRequests(f.context, (x) => f.events.push(x));
  await flush();
  assert.equal(f.events[0].errorName, 'other');
  assert.equal(f.events[0].errorClass, 'other');
  f.context.emit('request', {
    url: () => url,
    resourceType: () => 'fetch',
    method: () => 'GET',
    allHeaders: async () => ({})
  });
  await flush();
  assert.equal(f.events.find((x) => x.event === 'request').resourceType, 'fetch');
  assert.ok(!JSON.stringify(f.events).includes(secret));
  observer.dispose();
});
test('observation cap and malformed metadata do not expose unknown values or retain unlimited requests', async () => {
  const f = fixture();
  const observer = observeSessionConnections(
    f.context,
    (x) => f.events.push(x),
    responseReadMetadata
  );
  await flush();
  for (let n = 0; n < 35; n++) request(f, String(n));
  assert.equal(f.events.filter((x) => x.event === 'connection_request').length, 30);
  response(f, '0', {
    status: secret,
    connectionId: secret,
    connectionReused: secret,
    remoteIPAddress: secret,
    headers: { server: secret }
  });
  const row = f.events.at(-1);
  assert.equal(row.connectionId, undefined);
  assert.equal(row.remoteAddressHash, undefined);
  assert.equal(row.server, 'other');
  assert.ok(!JSON.stringify(f.events).includes(secret));
  f.cdp.emit('Network.loadingFailed', { requestId: '0', errorText: secret });
  assert.equal(f.events.at(-1).event, 'connection_failed');
  observer.dispose();
  response(f, '1');
});

test('runtime finally disposes diagnostics on successful and failed original browser close', async () => {
  const source = fs.readFileSync(require.resolve('../upstream/browser-runtime'), 'utf8');
  for (const failed of [false, true]) {
    let disposed = 0,
      closed = 0;
    const original = new Error('original cleanup failure');
    const session = {
      context: {},
      close: async () => {
        closed++;
        if (failed) throw original;
      }
    };
    const sandbox = {
      module: { exports: {} },
      process: { env: {} },
      console: { log() {} },
      require: (name) => {
        if (name === './browser-standalone')
          return { connectStandaloneBrowser: async () => session };
        if (name === './browser-pool-client') return {};
        if (name === './region-config')
          return {
            getRegionBrowserProfile: () => ({ locale: 'en-PH', timezoneId: 'Asia/Manila' })
          };
        if (name === '../subscription-diagnostics.cjs')
          return {
            observeSessionRequests: () => ({
              dispose: () => {
                disposed++;
                throw Error('diagnostic disposal');
              }
            })
          };
        throw Error('unexpected module');
      }
    };
    runInNewContext(source, sandbox);
    const result = await sandbox.module.exports.connectTaskBrowser({ env: {} });
    if (failed) await assert.rejects(result.close(), (error) => error === original);
    else await result.close();
    assert.equal(closed, 1);
    assert.equal(disposed, 1);
  }
});

test('blank Chromium attaches passive diagnostics within the unchanged budget without HTTP traffic', async () => {
  const { chromium } = require('../upstream/node_modules/playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--host-resolver-rules=MAP * ~NOTFOUND']
  });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let requests = 0;
    context.on('request', () => {
      requests++;
    });
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    const rows = [];
    let observed;
    const result = new Promise((resolve) => {
      observed = resolve;
    });
    const observer = observeSessionConnections(
      context,
      (row) => {
        rows.push(row);
        observed(row);
      },
      responseReadMetadata
    );
    try {
      assert.equal((await result).complete, true);
      await page.close();
      assert.equal(rows.length, 1);
      assert.equal(context.listenerCount('page'), 1);
    } finally {
      observer.dispose();
      assert.equal(context.listenerCount('page'), 0);
      await context.close();
    }
    assert.equal(requests, 0);
  } finally {
    await browser.close();
  }
});
