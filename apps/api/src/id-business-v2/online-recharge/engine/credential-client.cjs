'use strict';
let counter = 0;
const pending = new Map();
let override = null;
function requestCredential(cardId) {
  if (override) return Promise.resolve(override(cardId));
  if (!process.connected) return Promise.resolve('');
  const requestId = ++counter;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve('');
    }, 5000);
    pending.set(requestId, (cvc) => {
      clearTimeout(timer);
      pending.delete(requestId);
      resolve(cvc);
    });
    process.send({ type: 'credential', requestId, cardId });
  });
}
process.on('message', (message) => {
  if (message?.type !== 'credential') return;
  const resolve = pending.get(message.requestId);
  if (resolve) resolve(/^\d{3,4}$/.test(message.cvc || '') ? message.cvc : '');
  message.cvc = '';
});
function forgetCredential(cardId) {
  if (process.connected) process.send({ type: 'credential_forget', cardId });
}
module.exports = {
  requestCredential,
  forgetCredential,
  setRequesterForTest: (fn) => {
    override = fn;
  }
};
