'use strict';
/* global document, innerWidth, innerHeight, XMLHttpRequest */
const { randomUUID } = require('node:crypto');
const { rpc, wasSubmitted } = require('./rpc.cjs');
const {
  createVerificationBudget,
  prepareVerificationPage,
  inspectCaptchaFrames
} = require('./upstream/verification-runtime');

function failure(code = 'HUMAN_VERIFICATION_REQUIRED') {
  return Object.assign(new Error('人工验证未完成，本次未提交付款'), { code });
}
function homepage(page) {
  try {
    const url = new URL(page.url());
    return url.origin === 'https://chatgpt.com' && url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}
function verificationPage(page, options = {}) {
  if (options.sessionProbe !== true) return homepage(page);
  // Only the original, exact Session probe may opt in. Arbitrary auth/login,
  // checkout pages and query-bearing URLs are never exposed by this entry.
  try {
    return page.url() === 'https://chatgpt.com/api/auth/session';
  } catch {
    return false;
  }
}
async function challengeTarget(page) {
  const frames = await inspectCaptchaFrames(page);
  const challenges = frames.filter((item) => item.kind === 'challenge');
  const candidates = challenges.length ? challenges : frames;
  if (candidates.length !== 1) throw failure();
  const frame = candidates[0].frame;
  const element = await frame.frameElement();
  try {
    if (
      !(await element.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return [
          [0.1, 0.1],
          [0.5, 0.5],
          [0.9, 0.9]
        ].every(
          ([x, y]) =>
            document.elementFromPoint(box.x + box.width * x, box.y + box.height * y) === node
        );
      }))
    )
      throw failure();
    const box = await element.boundingBox();
    if (!box || box.width < 5 || box.height < 5 || box.width > 1400 || box.height > 1000)
      throw failure();
    return { frame, box };
  } finally {
    await element.dispose?.();
  }
}
async function hasActionableHumanVerification(page, options = {}) {
  if (!page || page.isClosed() || !verificationPage(page, options)) return false;
  if (!(await require('./upstream/human-verification').isBlockingHumanVerificationVisible(page)))
    return false;
  try {
    await challengeTarget(page);
    return true;
  } catch {
    return false;
  }
}
function sameBox(a, b) {
  return ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) < 0.5);
}
async function assertOriginalIdentity(page, sessionRaw, options = {}) {
  const auth = require('./upstream/session-auth');
  const resolved = auth.resolveSessionInput(sessionRaw);
  const profile = auth.extractProfileFromToken(resolved?.accessToken);
  const expectedAccount = profile.accountId || resolved?.sessionData?.account?.id;
  const expectedUser = resolved?.sessionData?.user?.id || profile.userId;
  if (!expectedAccount || !expectedUser || !homepage(page)) throw failure('ACCOUNT_MISMATCH');
  const budget = createVerificationBudget({ ...options, maxWaitMs: 8000 });
  const url = `https://chatgpt.com/api/auth/session?manual_verification=${randomUUID()}`;
  // Page routing takes precedence over the context compatibility response.
  // continue() sends the browser's actual cookie request through its existing proxy.
  const nativeRoute = (route) => route.continue();
  try {
    await budget.run(() => page.route(url, nativeRoute));
    const matches = await budget.run(() =>
      page.evaluate(
        ({ url, account, user, timeout }) =>
          new Promise((resolve) => {
            // The existing compatibility layer only patches fetch. This bounded XHR
            // reaches the explicit native route and returns identity booleans only.
            const request = new XMLHttpRequest();
            request.open('GET', url);
            request.timeout = timeout;
            request.withCredentials = true;
            request.onload = () => {
              try {
                if (request.status !== 200 || request.responseURL !== url) return resolve(false);
                const session = JSON.parse(request.responseText);
                let auth = {};
                if (typeof session.accessToken === 'string') {
                  const part = session.accessToken.split('.')[1];
                  auth =
                    JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')))[
                      'https://api.openai.com/auth'
                    ] || {};
                }
                const ids = [session.account?.id, auth.chatgpt_account_id].filter(Boolean);
                resolve(
                  ids.length > 0 && ids.every((id) => id === account) && session.user?.id === user
                );
              } catch {
                resolve(false);
              }
            };
            request.onerror = request.ontimeout = request.onabort = () => resolve(false);
            request.send();
          }),
        {
          url,
          account: expectedAccount,
          user: expectedUser,
          timeout: Math.max(1, Math.floor(budget.remaining()))
        }
      )
    );
    budget.assert();
    if (!matches || !homepage(page)) throw failure('ACCOUNT_MISMATCH');
  } finally {
    budget.dispose();
    await page.unroute(url, nativeRoute);
  }
}
async function waitForHumanVerification(page, options = {}, injected = {}) {
  const call = injected.rpc || rpc;
  const blocked =
    injected.blocked || require('./upstream/human-verification').isBlockingHumanVerificationVisible;
  const target = injected.target || challengeTarget;
  const originalPage = () => verificationPage(page, options);
  const state = await (injected.prepare || prepareVerificationPage)(page, {
    signal: options.signal
  });
  const initialGeneration = state.generation;
  const budget = createVerificationBudget({
    signal: options.signal,
    deadlineAt: options.deadlineAt,
    maxWaitMs: 120000
  });
  let generation,
    ack = 0,
    lastScreen;
  const screens = new Map();
  let active = true;
  let result, failureError;
  const revoke = () => {
    active = false;
  };
  const assert = () => {
    budget.assert();
    if (!active || wasSubmitted() || page.isClosed() || !originalPage()) throw failure();
  };
  const navigation = (frame) => {
    if (frame === page.mainFrame()) revoke();
  };
  const popup = (child) => {
    child.close({ runBeforeUnload: false }).catch(() => {});
    revoke();
  };
  page.on('framenavigated', navigation);
  page.on('popup', popup);
  try {
    assert();
    const opened = await budget.run(() =>
      call('humanVerificationOpen', {
        deadline: Date.now() + Math.max(1, Math.floor(budget.remaining()) - 10)
      })
    );
    generation = opened.generation;
    await budget.run(() =>
      call('progress', {
        stage: 'human_verification',
        message: '官网需要本人验证，请打开任务详情，在剩余期限内完成验证',
        progress: 10
      })
    );
    for (;;) {
      budget.assert();
      if (!active) {
        await budget.run(() =>
          page.waitForLoadState('domcontentloaded', {
            timeout: Math.max(1, Math.floor(budget.remaining()))
          })
        );
        if (!originalPage() || page.isClosed() || (await budget.run(() => blocked(page))))
          throw failure();
        result = { completed: true };
        break;
      }
      // A provider may reload the same homepage after success. Revoke first;
      // the caller still has to recheck the actual account and original preflight.
      if (!(await budget.run(() => blocked(page)))) {
        revoke();
        if (!originalPage() || page.isClosed()) throw failure();
        result = { completed: true };
        break;
      }
      assert();
      if (state.generation !== initialGeneration) throw failure();
      if (!lastScreen) {
        const current = await budget.run(() => target(page));
        assert();
        const image = await budget.run(() =>
          page.screenshot({
            type: 'png',
            scale: 'css',
            clip: current.box,
            timeout: Math.min(2000, budget.remaining())
          })
        );
        assert();
        const checked = await budget.run(() => target(page));
        if (checked.frame !== current.frame || !sameBox(current.box, checked.box)) throw failure();
        lastScreen = {
          ...current,
          capturedAt: Date.now(),
          frameUrl: current.frame.url(),
          revision: state.revision,
          frameId: randomUUID(),
          image: image.toString('base64'),
          width: image.readUInt32BE(16),
          height: image.readUInt32BE(20)
        };
        screens.set(lastScreen.frameId, lastScreen);
        while (screens.size > 3) screens.delete(screens.keys().next().value);
      }
      const update = await budget.run(() =>
        call('humanVerificationPoll', {
          generation,
          ack,
          screen: {
            frameId: lastScreen.frameId,
            image: lastScreen.image,
            width: lastScreen.width,
            height: lastScreen.height
          }
        })
      );
      assert();
      if (update.stopped) throw failure('HUMAN_VERIFICATION_CANCELLED');
      const command = update.command;
      if (command && command.sequence > ack) {
        const authorization = await budget.run(() =>
          call('humanVerificationAuthorize', { generation, sequence: command.sequence })
        );
        assert();
        if (authorization.authorized !== true) throw failure('HUMAN_VERIFICATION_CANCELLED');
        if (command.kind === 'click') {
          const shown = screens.get(command.frameId);
          const current = await budget.run(() => target(page));
          assert();
          if (
            !shown ||
            Date.now() - shown.capturedAt > 3000 ||
            current.frame.url() !== shown.frameUrl ||
            shown.revision !== state.revision ||
            current.frame !== shown.frame ||
            !sameBox(current.box, shown.box) ||
            !Number.isFinite(command.x) ||
            !Number.isFinite(command.y) ||
            command.x < 0 ||
            command.y < 0 ||
            command.x >= shown.width ||
            command.y >= shown.height
          ) {
            // A stale picture never authorizes a click. Acknowledge its removal
            // and publish the new picture while keeping the original deadline.
            ack = command.sequence;
            lastScreen = null;
            continue;
          }
          // Hit-test within the challenge frame. Never use page.mouse: an overlay
          // or moved iframe must not redirect the user's click to the host page.
          const element = await budget.run(() =>
            current.frame.evaluateHandle(
              ({ x, y }) => {
                let node = document.elementFromPoint(x * innerWidth, y * innerHeight);
                while (node?.shadowRoot) {
                  const nested = node.shadowRoot.elementFromPoint(x * innerWidth, y * innerHeight);
                  if (!nested || nested === node) break;
                  node = nested;
                }
                return node;
              },
              { x: command.x / shown.width, y: command.y / shown.height }
            )
          );
          try {
            const handle = element.asElement();
            if (!handle) throw failure();
            if (
              await handle.evaluate((node) =>
                Boolean(node.closest('a, input:not([type="checkbox"]), textarea, select'))
              )
            )
              throw failure();
            const box = await budget.run(() => handle.boundingBox());
            if (!box) throw failure();
            const position = {
              x: current.box.x + command.x - box.x,
              y: current.box.y + command.y - box.y
            };
            if (
              position.x < 0 ||
              position.y < 0 ||
              position.x >= box.width ||
              position.y >= box.height
            )
              throw failure();
            assert();
            await budget.run(() =>
              handle.click({
                position,
                timeout: Math.min(1000, budget.remaining()),
                noWaitAfter: true
              })
            );
          } finally {
            await element.dispose?.();
          }
        } else if (command.kind !== 'continue') throw failure();
        ack = command.sequence;
        lastScreen = null;
      } else if (!command) lastScreen = null;
      await budget.wait(500);
    }
  } catch (error) {
    failureError = error;
  } finally {
    revoke();
    screens.clear();
    page.off('framenavigated', navigation);
    page.off('popup', popup);
    budget.dispose();
  }
  // A missing close acknowledgement stops this task; it cannot continue to checkout.
  if (generation) {
    try {
      const closed = await call('humanVerificationClose', { generation }, { timeoutMs: 3000 });
      if (closed?.stopped !== true) throw failure();
    } catch (error) {
      failureError ||= error;
    }
  }
  if (failureError) throw failureError;
  return result;
}
module.exports = {
  waitForHumanVerification,
  hasActionableHumanVerification,
  challengeTarget,
  sameBox,
  homepage,
  assertOriginalIdentity
};
