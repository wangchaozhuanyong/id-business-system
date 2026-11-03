'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const credentials = require('../credentials.cjs');
test('task-scoped CVC claim stays private and cannot cross task ownership', async () => {
  const key = 'synthetic-private-key-not-used-externally';
  const service = await credentials.start({ url: 'http://127.0.0.1:0', key });
  const url = `http://127.0.0.1:${service.server.address().port}`;
  const post = async (path, body, auth = key) => {
    const response = await fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-online-recharge-worker': auth },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal(
      (await post('/credentials/claim', { cardId: 'card', taskId: 'task' }, 'wrong')).status,
      401
    );
    await post('/credentials', { cards: [{ id: 'card', cvc: '123' }] });
    assert.deepEqual((await post('/credentials/status', { ids: ['card'] })).body, {
      availableIds: ['card']
    });
    assert.equal(
      (await post('/credentials/claim', { cardId: 'card', taskId: 'first-task' })).body.cvc,
      '123'
    );
    assert.equal(
      (await post('/credentials/claim', { cardId: 'card', taskId: 'other-task' })).body.cvc,
      ''
    );
    credentials.forgetTask('first-task');
    assert.equal(
      (await post('/credentials/claim', { cardId: 'card', taskId: 'first-task' })).body.cvc,
      ''
    );
    await post('/credentials', { cards: [{ id: 'card', cvc: '456' }] });
    assert.equal(
      (await post('/credentials/claim', { cardId: 'card', taskId: 'new-task' })).body.cvc,
      '456'
    );
    await post('/credentials/release', { cardId: 'card', taskId: 'first-task' });
    assert.equal(
      (await post('/credentials/claim', { cardId: 'card', taskId: 'new-task' })).body.cvc,
      '456'
    );
    await post('/credentials/release', { cardId: 'card', taskId: 'new-task' });
    assert.equal(
      (await post('/credentials/claim', { cardId: 'card', taskId: 'new-task' })).body.cvc,
      ''
    );
  } finally {
    await service.close();
  }
});
