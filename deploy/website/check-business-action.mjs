import assert from 'node:assert/strict';

export async function confirmSyntheticBusinessAction(send, session, credentials, security) {
  assert.equal(security.passwordConfirmed, false);
  const result = await send('/api/local/auth/security/confirm-password', {
    method: 'POST', session, body: { password: credentials.password }
  });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).confirmed, true);
}
