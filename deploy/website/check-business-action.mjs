import assert from 'node:assert/strict';

export async function confirmSyntheticBusinessAction(send, session, credentials, security) {
  assert.equal(security.passwordConfirmed, true);
  const result = await send('/api/local/auth/security/confirm-password', {
    method: 'POST', session, body: { password: credentials.password }
  });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).confirmed, true);
  const readback = await send('/api/local/auth/security', { session });
  assert.equal(readback.status, 200);
  assert.equal(JSON.parse(readback.body).passwordConfirmed, true);
}
