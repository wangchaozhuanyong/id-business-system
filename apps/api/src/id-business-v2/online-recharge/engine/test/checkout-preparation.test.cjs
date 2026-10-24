'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { acquire } = require('../checkout-preparation.cjs');

const accepted = {
  checkoutUrl: 'https://chatgpt.com/checkout/openai_llc/oaics_synthetic',
  sessionId: 'oaics_synthetic',
  creationState: 'accepted'
};
test('补码恢复读取已保存原单，不再次创建 Checkout', async () => {
  let posts = 0,
    checkpoint;
  const persistence = {
    save: async (value) => {
      checkpoint = value;
      return { checkoutPreparationState: value.state };
    }
  };
  const create = async () => {
    posts++;
    return accepted;
  };
  await acquire(persistence, create);
  assert.equal(checkpoint.state, 'created');
  const result = await acquire({ ...persistence, previous: checkpoint }, create);
  assert.equal(posts, 1);
  assert.equal(result.checkoutUrl, accepted.checkoutUrl);
});
test('建单已发出但未取得回执，下一次领取不能再 POST', async () => {
  let checkpoint,
    posts = 0;
  await assert.rejects(
    acquire(
      {
        save: async (value) => {
          checkpoint = value;
          return { checkoutPreparationState: value.state };
        }
      },
      async () => {
        posts++;
        throw Error('synthetic connection interruption');
      }
    )
  );
  await assert.rejects(
    acquire({ previous: checkpoint }, async () => {
      posts++;
    }),
    (error) => error.code === 'CHECKOUT_CREATION_UNKNOWN'
  );
  assert.equal(posts, 1);
});
test('原单保存失败不作为未建单回退条件', async () => {
  await assert.rejects(
    acquire(
      {
        save: async (value) => {
          if (value.state === 'created') throw Error('synthetic persistence interruption');
          return { checkoutPreparationState: value.state };
        }
      },
      async () => accepted
    ),
    (error) => error.checkoutCreationState === 'accepted'
  );
});
test('建单意图保存失败时不发请求', async () => {
  let posts = 0;
  await assert.rejects(
    acquire(
      {
        save: async () => {
          throw Error('synthetic unavailable');
        }
      },
      async () => {
        posts++;
      }
    )
  );
  assert.equal(posts, 0);
});

test('正式 openApiCheckout 接入已保存原单时，不调用实际建单传输', async () => {
  let posts = 0;
  const page = {
    context: () => ({
      request: {
        post: async () => {
          posts++;
          throw Error('Unexpected POST');
        }
      }
    })
  };
  const result = await require('../upstream/chatgpt').openApiCheckout(page, {
    accessToken: 'synthetic-test-token',
    planType: 'plus',
    country: 'PH',
    currency: 'PHP',
    verifyPage: false,
    checkoutPersistence: {
      previous: { ...accepted, state: 'created' },
      save: async () => {
        throw Error('Unexpected save');
      }
    }
  });
  assert.equal(posts, 0);
  assert.equal(result.checkoutUrl, accepted.checkoutUrl);
});

test('旧 API 未确认保存原单准备资料时，不能开始建单', async () => {
  let posts = 0;
  await assert.rejects(
    acquire({ save: async () => ({ ok: true }) }, async () => {
      posts++;
    }),
    (error) => error.code === 'CHECKOUT_CREATION_UNKNOWN'
  );
  assert.equal(posts, 0);
});
